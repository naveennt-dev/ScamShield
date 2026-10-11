"""
Model loading for production inference.

Security: `joblib` (pickle) files can execute code when loaded. We therefore only load from the
configured local models directory and only after verifying the SHA-256 recorded in
model_manifest.json at training time. A tampered or mismatched file is refused.
"""
from __future__ import annotations

import hashlib
import json
import math
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from inference.preprocessing import TOKENIZER_VERSION, char_features, word_features

DEFAULT_MODELS_DIR = Path(__file__).resolve().parents[1] / "models"


class ModelLoadError(RuntimeError):
    pass


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_manifest(models_dir: Path = DEFAULT_MODELS_DIR) -> dict[str, Any]:
    path = models_dir / "model_manifest.json"
    if not path.exists():
        raise ModelLoadError(f"{path} not found — train a model first (npm run ml:train)")
    manifest = json.loads(path.read_text())
    if manifest.get("tokenizerVersion") != TOKENIZER_VERSION:
        raise ModelLoadError(f"tokenizer mismatch: model {manifest.get('tokenizerVersion')} vs code {TOKENIZER_VERSION}")
    return manifest


def verified_path(models_dir: Path, manifest: dict, kind: str) -> Path:
    info = manifest["files"][kind]
    path = (models_dir / info["path"]).resolve()
    if path.parent != models_dir.resolve():
        raise ModelLoadError("model path escapes the models directory")
    if not path.exists():
        raise ModelLoadError(f"{path.name} not found")
    if _sha256(path) != info["sha256"]:
        raise ModelLoadError(f"{path.name}: SHA-256 mismatch — refusing to load")
    return path


@dataclass
class SklearnModel:
    manifest: dict
    label_pipeline: Any
    calibrator: Any
    category_model: Any

    @classmethod
    def load(cls, models_dir: Path = DEFAULT_MODELS_DIR) -> "SklearnModel":
        import joblib  # imported lazily: only needed for the service

        manifest = load_manifest(models_dir)
        bundle = joblib.load(verified_path(models_dir, manifest, "joblib"))
        return cls(manifest, bundle["label_pipeline"], bundle.get("calibrator"), bundle["category_model"])

    @property
    def label_estimator(self) -> Any:
        """Calibrated estimator if available, else the raw pipeline."""
        return self.calibrator if self.calibrator is not None else self.label_pipeline

    def predict(self, text: str) -> dict:
        features = self.label_pipeline.named_steps["features"]
        X = features.transform([text])
        est = self.label_estimator
        probs = est.predict_proba([text])[0]
        label_proba = {str(c): float(p) for c, p in zip(est.classes_, probs)}
        word_block = features.transformer_list[0][1].transform([text])
        category_proba = None
        if self.category_model is not None:
            cp = self.category_model.predict_proba(X)[0]
            category_proba = {str(c): float(p) for c, p in zip(self.category_model.classes_, cp)}
        return {"labelProba": label_proba, "categoryProba": category_proba, "knownFeatures": int(word_block.nnz)}


class JsonModel:
    """Dependency-free reference implementation of the portable JSON model (mirrors the TS fallback)."""

    def __init__(self, m: dict):
        if m.get("tokenizerVersion") != TOKENIZER_VERSION:
            raise ModelLoadError("tokenizer mismatch")
        self.m = m
        self.word_vocab = m["features"]["word"]["vocabulary"]
        self.char_vocab = m["features"]["char"]["vocabulary"]
        self.word_idf = m["features"]["word"]["idf"]
        self.char_idf = m["features"]["char"]["idf"]
        self.offset = len(self.word_idf)

    @classmethod
    def load(cls, path: Path) -> "JsonModel":
        return cls(json.loads(Path(path).read_text()))

    @staticmethod
    def _block(terms: list[str], vocab: dict, idf: list[float], offset: int) -> dict[int, float]:
        counts = Counter(t for t in terms if t in vocab)
        vec = {vocab[t] + offset: (1.0 + math.log(c)) * idf[vocab[t]] for t, c in counts.items()}
        norm = math.sqrt(sum(v * v for v in vec.values()))
        return {k: v / norm for k, v in vec.items()} if norm > 0 else vec

    def features(self, text: str) -> tuple[dict[int, float], int]:
        w = self._block(word_features(text), self.word_vocab, self.word_idf, 0)
        c = self._block(char_features(text), self.char_vocab, self.char_idf, self.offset)
        return {**w, **c}, len(w)

    @staticmethod
    def _scores(head: dict, x: dict[int, float]) -> dict[str, float]:
        logits = [b + sum(w[i] * v for i, v in x.items()) for w, b in zip(head["coef"], head["intercept"])]
        cal = head.get("calibration")
        if cal and cal["method"] == "sigmoid":
            # sklearn _SigmoidCalibration: p_k = 1 / (1 + exp(a_k·z_k + b_k)), then normalised.
            raw = [1.0 / (1.0 + math.exp(a * z + b)) for z, a, b in zip(logits, cal["a"], cal["b"])]
            s = sum(raw)
            return {c: (r / s if s > 0 else 1.0 / len(raw)) for c, r in zip(head["classes"], raw)}
        if head["binary"]:
            p1 = 1 / (1 + math.exp(-logits[0]))
            return {head["classes"][0]: 1 - p1, head["classes"][1]: p1}
        mx = max(logits)
        ex = [math.exp(z - mx) for z in logits]
        s = sum(ex)
        return {c: e / s for c, e in zip(head["classes"], ex)}

    def label_proba(self, text: str) -> dict[str, float]:
        return self._scores(self.m["label"], self.features(text)[0])

    def predict(self, text: str) -> dict:
        x, known = self.features(text)
        return {
            "labelProba": self._scores(self.m["label"], x),
            "categoryProba": self._scores(self.m["category"], x) if self.m.get("category") else None,
            "knownFeatures": known,
        }
