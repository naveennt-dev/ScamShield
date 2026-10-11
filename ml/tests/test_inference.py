import json
import shutil
from pathlib import Path

import pytest

from inference.model_loader import DEFAULT_MODELS_DIR, JsonModel, ModelLoadError, SklearnModel, load_manifest
from inference.predict import MAX_CHARS, Predictor

pytestmark = pytest.mark.skipif(not (DEFAULT_MODELS_DIR / "model_manifest.json").exists(), reason="train a model first")


@pytest.fixture(scope="module")
def predictor():
    return Predictor()


def test_prediction_shape_and_model_version(predictor):
    r = predictor.predict("Dear customer your KYC has expired, share OTP at http://kyc-help.xyz")
    assert r["classification"] in {"safe", "suspicious", "scam"}
    assert 0 <= r["probability"] <= 1
    assert abs(sum(r["probabilities"].values()) - 1) < 1e-6
    assert r["model"]["name"] == "scam-tfidf-logreg" and r["model"]["version"]
    assert r["category"] is None or isinstance(r["category"], str)


def test_obvious_cases(predictor):
    assert predictor.predict("Hey, are we still meeting for lunch tomorrow?")["classification"] == "safe"
    assert predictor.predict("Congratulations! You have won Rs 25 lakh in the KBC lottery. Pay processing fee to claim")["classification"] != "safe"


def test_unicode_inputs(predictor):
    for text in ["आपका खाता बंद कर दिया जाएगा", "Apka KYC expire ho gya hai", "🙂🙂🙂 ok", "Ünïcödé"]:
        assert predictor.predict(text)["classification"] in {"safe", "suspicious", "scam"}


@pytest.mark.parametrize("bad", ["", "   \n", "x" * (MAX_CHARS + 1), None, 42])
def test_invalid_input(predictor, bad):
    with pytest.raises(ValueError):
        predictor.predict(bad)


def test_deterministic(predictor):
    t = "Your parcel is held at customs, pay the fee"
    assert predictor.predict(t) == predictor.predict(t)


def test_json_backend_matches_sklearn(predictor):
    jm = Predictor(backend="json")
    for t in ["Share your OTP now", "lunch at 1?", "Earn 3000 daily liking videos, registration fee 500"]:
        a, b = predictor.predict(t)["probabilities"], jm.predict(t)["probabilities"]
        assert all(abs(a[k] - b[k]) < 1e-4 for k in a)


def test_tampered_model_is_refused(tmp_path: Path):
    for f in DEFAULT_MODELS_DIR.glob("*"):
        if f.is_file():
            shutil.copy(f, tmp_path / f.name)
    blob = tmp_path / load_manifest()["files"]["joblib"]["path"]
    blob.write_bytes(blob.read_bytes() + b"tamper")
    with pytest.raises(ModelLoadError, match="SHA-256"):
        SklearnModel.load(tmp_path)


def test_tokenizer_version_mismatch_refused(tmp_path: Path):
    m = load_manifest()
    m["tokenizerVersion"] = "v0"
    (tmp_path / "model_manifest.json").write_text(json.dumps(m))
    with pytest.raises(ModelLoadError, match="tokenizer"):
        load_manifest(tmp_path)
    with pytest.raises(ModelLoadError):
        JsonModel({"tokenizerVersion": "v0"})


def test_missing_model(tmp_path: Path):
    with pytest.raises(ModelLoadError, match="not found"):
        SklearnModel.load(tmp_path)
