#!/usr/bin/env python3
"""
Production inference: load an existing model artifact → preprocess → predict. Never trains.

  python ml/inference/predict.py --text "Your KYC has expired, click here"
  python ml/inference/predict.py --fixture src/lib/detection/ml/__fixtures__/parity.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from inference.model_loader import DEFAULT_MODELS_DIR, JsonModel, SklearnModel, load_manifest  # noqa: E402
from inference.preprocessing import tokenize  # noqa: E402

MAX_CHARS = 10_000


class Predictor:
    def __init__(self, models_dir: Path = DEFAULT_MODELS_DIR, backend: str = "sklearn"):
        self.manifest = load_manifest(models_dir)
        self.backend = backend
        self.model = SklearnModel.load(models_dir) if backend == "sklearn" else JsonModel.load(models_dir / self.manifest["files"]["json"]["path"])

    @property
    def model_info(self) -> dict:
        return {"name": self.manifest["name"], "version": self.manifest["version"], "buildId": self.manifest["buildId"],
                "trainingKind": self.manifest.get("trainingData", {}).get("kind", "unknown")}

    def predict(self, text: str) -> dict:
        if not isinstance(text, str) or not text.strip():
            raise ValueError("text must be a non-empty string")
        if len(text) > MAX_CHARS:
            raise ValueError(f"text exceeds {MAX_CHARS} characters")
        raw = self.model.predict(text)
        label_proba = raw["labelProba"]
        label = max(label_proba, key=label_proba.get)
        cat = raw["categoryProba"]
        category = max(cat, key=cat.get) if cat else None
        return {
            "classification": label,
            # Raw (uncalibrated) LR probability of the predicted class — a confidence score, not a
            # guaranteed real-world frequency (see docs/ml/evaluation.md#calibration).
            "probability": label_proba[label],
            "probabilities": label_proba,
            "category": category,
            "categoryProbability": cat[category] if cat and category else None,
            "knownFeatures": raw["knownFeatures"],
            "model": self.model_info,
        }


FIXTURE_TEXTS = [
    "123456 is your OTP for login. Do not share it with anyone.",
    "Dear SBI customer your KYC has expired, update now at http://sbi-kyc.xyz/login or account will be blocked",
    "Your account will be blocked! Pay ₹499 now: https://fake-example.com",
    "Congratulations you have won Rs 25,00,000 in lucky draw, call +91 98765 43210",
    "Earn 5% daily, mail us at invest@profit-club.io or visit bit.ly/x1",
    "Hey are we still meeting for lunch tomorrow?",
    "Apka KYC expire ho gya hai, abhi verify kro",
    "आपका KYC expire हो गया है, तुरंत अपडेट करें",
    "प्रिय ग्राहक, आपका खाता बंद कर दिया जाएगा",
    "Your acc0unt is susp3nded. Verlfy at secure-login.top",
    "",
    "Ünïcödé ｆｕｌｌｗｉｄｔｈ ＯＴＰ १२३ 123 text with zero​width and www.example.co.uk/a?b=1",
]


def write_fixture(path: Path) -> None:
    jm = JsonModel.load(DEFAULT_MODELS_DIR / load_manifest()["files"]["json"]["path"])
    cases = []
    for t in FIXTURE_TEXTS:
        r = jm.predict(t) if t else {"labelProba": jm.label_proba(t), "categoryProba": None, "knownFeatures": 0}
        cases.append({"text": t, "tokens": tokenize(t), "labelProba": r["labelProba"], "categoryProba": r["categoryProba"]})
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"modelBuildId": jm.m["buildId"], "cases": cases}, indent=2, ensure_ascii=False))
    print(f"wrote {len(cases)} parity cases to {path}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text")
    ap.add_argument("--fixture", type=Path)
    ap.add_argument("--backend", choices=["sklearn", "json"], default="sklearn")
    a = ap.parse_args()
    if a.fixture:
        write_fixture(a.fixture)
        return
    p = Predictor(backend=a.backend)
    print(json.dumps(p.predict(a.text if a.text is not None else sys.stdin.read()), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
