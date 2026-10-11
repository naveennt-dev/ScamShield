import pytest
from fastapi.testclient import TestClient

from inference.model_loader import DEFAULT_MODELS_DIR
from inference.service import create_app

pytestmark = pytest.mark.skipif(not (DEFAULT_MODELS_DIR / "model_manifest.json").exists(), reason="train a model first")


@pytest.fixture(scope="module")
def client():
    return TestClient(create_app())


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200 and r.json()["model"]["name"] == "scam-tfidf-logreg"


def test_predict_valid(client):
    r = client.post("/predict", json={"text": "Your KYC expired, share OTP now"})
    assert r.status_code == 200
    body = r.json()
    assert body["classification"] in {"safe", "suspicious", "scam"} and 0 <= body["probability"] <= 1
    assert body["processingTimeMs"] >= 0 and body["model"]["version"]


@pytest.mark.parametrize("payload,status,code", [
    ({}, 422, "VALIDATION_ERROR"),
    ({"text": ""}, 422, "VALIDATION_ERROR"),
    ({"text": "   "}, 422, "VALIDATION_ERROR"),
    ({"text": 5}, 422, "VALIDATION_ERROR"),
    ({"text": "hi", "userId": "x"}, 422, "VALIDATION_ERROR"),
    ({"text": "a" * 10_001}, 422, "VALIDATION_ERROR"),
])
def test_predict_invalid(client, payload, status, code):
    r = client.post("/predict", json=payload)
    assert r.status_code == status and r.json()["error"]["code"] == code
    assert "Traceback" not in r.text


def test_malformed_json(client):
    r = client.post("/predict", content=b"{bad", headers={"content-type": "application/json"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION_ERROR"


def test_body_limit(client):
    r = client.post("/predict", content=b"x" * (70 * 1024), headers={"content-type": "application/json"})
    assert r.status_code == 413


def test_no_docs_endpoints(client):
    for path in ("/docs", "/openapi.json", "/redoc"):
        assert client.get(path).status_code == 404


def test_service_without_model(tmp_path):
    c = TestClient(create_app(tmp_path))
    assert c.get("/health").status_code == 503
    assert c.post("/predict", json={"text": "hi"}).json()["error"]["code"] == "MODEL_UNAVAILABLE"


def test_refuses_non_loopback_bind(monkeypatch):
    from inference import service
    monkeypatch.setenv("ML_SERVICE_HOST", "0.0.0.0")
    with pytest.raises(SystemExit, match="local-only"):
        service.main()
