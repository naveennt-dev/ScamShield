#!/usr/bin/env python3
"""
Local ML inference service (FastAPI). Bound to loopback only; never exposed publicly.

  python ml/inference/service.py                 # 127.0.0.1:${ML_SERVICE_PORT:-8765}

POST /predict  {"text": "..."}  → classification, probability, category, model
GET  /health   → model name/version/build

Security: strict Pydantic validation (unknown fields rejected), 10 000-char limit, 64 KB body
limit, structured errors, text never logged (only length + latency), text never executed.
"""
from __future__ import annotations

import ipaddress
import logging
import os
import sys
import time
from pathlib import Path

import re

from fastapi import FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from inference.model_loader import DEFAULT_MODELS_DIR, ModelLoadError  # noqa: E402
from inference.predict import MAX_CHARS, Predictor  # noqa: E402

MAX_BODY_BYTES = 64 * 1024
log = logging.getLogger("scamshield.ml")


class PredictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)
    text: str = Field(min_length=1, max_length=MAX_CHARS)

    @field_validator("text")
    @classmethod
    def not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("text must not be blank")
        return v


class ModelInfo(BaseModel):
    name: str
    version: str
    buildId: str
    trainingKind: str


class PredictResponse(BaseModel):
    classification: str = Field(pattern="^(safe|suspicious|scam)$")
    probability: float = Field(ge=0, le=1)
    probabilities: dict[str, float]
    category: str | None
    categoryProbability: float | None = Field(default=None, ge=0, le=1)
    knownFeatures: int = Field(ge=0)
    model: ModelInfo
    processingTimeMs: float



# Correlation id from the API (scan id); only safe characters are ever logged.
REQUEST_ID_RE = re.compile(r"[A-Za-z0-9._-]{1,80}")

def error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


def create_app(models_dir: Path = DEFAULT_MODELS_DIR) -> FastAPI:
    app = FastAPI(title="ScamShield ML", docs_url=None, redoc_url=None, openapi_url=None)
    state: dict = {}
    try:
        state["predictor"] = Predictor(models_dir)
    except ModelLoadError as e:
        state["load_error"] = str(e)

    @app.middleware("http")
    async def limit_body(request: Request, call_next):
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > MAX_BODY_BYTES:
            return error(413, "PAYLOAD_TOO_LARGE", "Request body too large.")
        return await call_next(request)

    @app.exception_handler(RequestValidationError)
    async def on_validation(_: Request, exc: RequestValidationError):
        fields = sorted({".".join(str(p) for p in e.get("loc", [])[1:]) or "body" for e in exc.errors()})
        return error(422, "VALIDATION_ERROR", f"Invalid request: {', '.join(fields)}")

    @app.exception_handler(Exception)
    async def on_error(_: Request, exc: Exception):
        log.error("unhandled %s", type(exc).__name__)
        return error(500, "INTERNAL_ERROR", "Inference failed.")

    @app.get("/health")
    def health():
        p = state.get("predictor")
        if not p:
            return error(503, "MODEL_UNAVAILABLE", state.get("load_error", "model not loaded"))
        return {"status": "ok", "model": p.model_info}

    @app.post("/predict", response_model=PredictResponse)
    def predict(req: PredictRequest, x_request_id: str | None = Header(default=None)):
        p = state.get("predictor")
        if not p:
            return error(503, "MODEL_UNAVAILABLE", "Model not loaded.")
        t0 = time.perf_counter()
        result = p.predict(req.text)
        ms = round((time.perf_counter() - t0) * 1000, 2)
        rid = x_request_id if x_request_id and REQUEST_ID_RE.fullmatch(x_request_id) else "-"
        log.info("predict rid=%s len=%d ms=%.1f label=%s", rid, len(req.text), ms, result["classification"])
        return {**result, "processingTimeMs": ms}

    return app


def main() -> None:
    import uvicorn

    host = os.environ.get("ML_SERVICE_HOST", "127.0.0.1")
    if not ipaddress.ip_address(host).is_loopback:
        raise SystemExit(f"Refusing to bind {host}: the ML service is local-only (use 127.0.0.1 or ::1).")
    port = int(os.environ.get("ML_SERVICE_PORT", "8765"))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    uvicorn.run(create_app(), host=host, port=port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
