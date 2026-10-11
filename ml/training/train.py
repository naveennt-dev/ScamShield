#!/usr/bin/env python3
"""
Train the ScamShield baseline: TF-IDF (word 1–2-grams + in-word char 3–5-grams) → Logistic Regression.

  python ml/training/preprocess.py     # build processed splits first
  python ml/training/train.py

1. Select C on the VALIDATION split (objective: macro-F1 + scam recall — missed scams cost most).
2. Refit on train+val with the chosen C. The TEST split is never used here (see evaluate.py).
3. Category head (non-safe rows) on the same features.
4. Write artifacts to ml/models/:
     scam_classifier.joblib   sklearn pipeline (used by the Python inference service)
     scam_classifier.json     portable weights (used by the embedded TypeScript fallback)
     model_manifest.json      name, version, build id, tokenizer version, SHA-256 of both files

Calibration (config.CALIBRATION="sigmoid"): the classifier is trained on TRAIN only and a per-class
sigmoid (Platt) calibrator is fitted on VALIDATION; probabilities served are calibrated. With
CALIBRATION="none" the classifier is refit on train+val and serves raw LR probabilities.
"""
from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
from sklearn.calibration import CalibratedClassifierCV
from sklearn.frozen import FrozenEstimator
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import f1_score, recall_score
from sklearn.pipeline import FeatureUnion, Pipeline

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from inference.preprocessing import TOKENIZER_VERSION, char_features, word_features  # noqa: E402
from training import config  # noqa: E402


def load_split(name: str) -> list[dict]:
    path = config.PROCESSED_DIR / f"{name}.jsonl"
    if not path.exists():
        raise SystemExit(f"{path} missing — run ml/training/preprocess.py first")
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def make_features() -> FeatureUnion:
    return FeatureUnion([
        ("word", TfidfVectorizer(analyzer=word_features, sublinear_tf=True, norm="l2", min_df=config.WORD_MIN_DF)),
        ("char", TfidfVectorizer(analyzer=char_features, sublinear_tf=True, norm="l2", min_df=config.CHAR_MIN_DF,
                                 max_features=config.CHAR_MAX_FEATURES)),
    ])


def make_pipeline(C: float) -> Pipeline:
    return Pipeline([
        ("features", make_features()),
        ("lr", LogisticRegression(C=C, class_weight="balanced", max_iter=5000, random_state=config.SEED)),
    ])


def is_external(row: dict) -> bool:
    return not row["source"].startswith("synthetic")


def sample_weights(rows: list[dict], ratio: float | None) -> list[float]:
    n_ext = sum(is_external(r) for r in rows)
    n_dom = len(rows) - n_ext
    w_ext = (ratio * n_dom / n_ext) if (ratio and n_ext) else 1.0
    return [w_ext if is_external(r) else 1.0 for r in rows]


def objective(y_true: list[str], y_pred: list[str]) -> float:
    macro = f1_score(y_true, y_pred, average="macro", zero_division=0)
    scam_recall = recall_score(y_true, y_pred, labels=["scam"], average="macro", zero_division=0)
    return macro + config.SCAM_RECALL_WEIGHT * scam_recall


def export_head(lr: LogisticRegression) -> dict:
    return {"classes": [str(c) for c in lr.classes_], "coef": np.round(lr.coef_, 6).tolist(),
            "intercept": np.round(lr.intercept_, 6).tolist(), "binary": len(lr.classes_) == 2}


def export_vectorizer(v: TfidfVectorizer) -> dict:
    return {"vocabulary": {str(t): int(i) for t, i in v.vocabulary_.items()}, "idf": np.round(v.idf_, 6).tolist()}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    train, val = load_split("train"), load_split("val")
    Xtr, ytr = [r["text"] for r in train], [r["label"] for r in train]
    Xva, yva = [r["text"] for r in val], [r["label"] for r in val]

    # 1. Model selection on validation (C × external weight ratio)
    dom_va = [r for r in val if not is_external(r)]
    ext_safe_va = [r for r in val if is_external(r) and r["label"] == "safe"]
    scores: dict[str, float] = {}
    best = None
    for ratio in config.EXTERNAL_WEIGHT_RATIOS:
        for C in config.C_GRID:
            pipe = make_pipeline(C).fit(Xtr, ytr, lr__sample_weight=sample_weights(train, ratio))
            score = objective([r["label"] for r in dom_va], list(pipe.predict([r["text"] for r in dom_va]))) if dom_va else 0.0
            fpr = (sum(p != "safe" for p in pipe.predict([r["text"] for r in ext_safe_va])) / len(ext_safe_va)) if ext_safe_va else 0.0
            score = round(score - config.EXTERNAL_FPR_PENALTY * fpr, 4)
            scores[f"ratio={ratio},C={C}"] = score
            if best is None or score > best[0]:
                best = (score, ratio, C)
    _, best_ratio, best_C = best
    print(f"[train] validation objective: {scores} → ratio={best_ratio}, C={best_C}")

    # 2. Final fit. With calibration the validation split is reserved for the calibrator.
    calibrator = None
    if config.CALIBRATION == "sigmoid":
        X, y, fit_rows = Xtr, ytr, train
        pipe = make_pipeline(best_C).fit(X, y, lr__sample_weight=sample_weights(train, best_ratio))
        calibrator = CalibratedClassifierCV(FrozenEstimator(pipe), method="sigmoid").fit(Xva, yva)
    else:
        X, y, fit_rows = Xtr + Xva, ytr + yva, train + val
        pipe = make_pipeline(best_C).fit(X, y, lr__sample_weight=sample_weights(fit_rows, best_ratio))
    features: FeatureUnion = pipe.named_steps["features"]
    word_vec: TfidfVectorizer = features.transformer_list[0][1]
    char_vec: TfidfVectorizer = features.transformer_list[1][1]

    # 3. Category head
    # Weakly-labelled external spam has no real category → excluded from the category head.
    rows = [r for r in fit_rows if r["label"] != "safe" and not is_external(r)]
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["category"]] = counts.get(r["category"], 0) + 1
    cats = [r["category"] if counts[r["category"]] >= config.MIN_CATEGORY_EXAMPLES else "other" for r in rows]
    category_lr = None
    if len(set(cats)) >= 2:
        category_lr = LogisticRegression(C=best_C, class_weight="balanced", max_iter=5000, random_state=config.SEED)
        category_lr.fit(features.transform([r["text"] for r in rows]), cats)

    # 4. Artifacts
    created = datetime.now(timezone.utc)
    data_sha = json.loads((config.PROCESSED_DIR / "split_manifest.json").read_text())["data_sha256"]
    build_id = f"{config.MODEL_VERSION}+{created:%Y%m%d}.{data_sha[:8]}"
    sources = sorted({r["source"] for r in train + val})
    # "synthetic" only if every row is hand-written; otherwise "mixed" (synthetic + public real data).
    training_kind = "synthetic" if all(s.startswith("synthetic") for s in sources) else "mixed"
    config.MODELS_DIR.mkdir(parents=True, exist_ok=True)
    joblib_path = config.MODELS_DIR / "scam_classifier.joblib"
    json_path = config.MODELS_DIR / "scam_classifier.json"
    joblib.dump({"label_pipeline": pipe, "calibrator": calibrator, "category_model": category_lr}, joblib_path)
    label_head = export_head(pipe.named_steps["lr"])
    if calibrator is not None:
        cal = calibrator.calibrated_classifiers_[0].calibrators
        assert [str(c) for c in calibrator.classes_] == label_head["classes"]
        label_head["calibration"] = {"method": "sigmoid", "a": [round(float(c.a_), 6) for c in cal], "b": [round(float(c.b_), 6) for c in cal]}

    portable = {
        "format": "scamshield-tfidf-lr", "formatVersion": 2, "tokenizerVersion": TOKENIZER_VERSION,
        "name": config.MODEL_NAME, "version": config.MODEL_VERSION, "buildId": build_id, "createdAt": created.isoformat(),
        "trainingData": {"kind": training_kind, "rows": len(X), "dataSha256": data_sha, "sources": sources},
        "features": {"word": export_vectorizer(word_vec), "char": export_vectorizer(char_vec), "charNgramRange": [3, 5]},
        "label": label_head,
        "category": export_head(category_lr) if category_lr is not None else None,
        "hyperparameters": {"C": best_C, "externalWeightRatio": best_ratio, "validationObjective": scores},
    }
    json_path.write_text(json.dumps(portable, separators=(",", ":"), ensure_ascii=False))

    manifest = {
        "name": config.MODEL_NAME, "version": config.MODEL_VERSION, "buildId": build_id, "createdAt": created.isoformat(),
        "tokenizerVersion": TOKENIZER_VERSION, "labels": [str(c) for c in pipe.classes_],
        "categories": [str(c) for c in category_lr.classes_] if category_lr is not None else [],
        "probabilityType": "calibrated-sigmoid-on-validation" if calibrator is not None else "raw-uncalibrated",
        "trainingData": {"kind": training_kind, "rows": len(X), "dataSha256": data_sha, "sources": sources},
        "files": {"joblib": {"path": joblib_path.name, "sha256": sha256(joblib_path)},
                  "json": {"path": json_path.name, "sha256": sha256(json_path)}},
    }
    (config.MODELS_DIR / "model_manifest.json").write_text(json.dumps(manifest, indent=2))

    # Fidelity: the portable JSON maths must reproduce sklearn.
    sys.path.insert(0, str(config.ML))
    from inference.model_loader import JsonModel  # noqa: E402
    jm = JsonModel.load(json_path)
    reference = calibrator if calibrator is not None else pipe
    sample = Xva[:40] + X[:40]
    worst = max(abs(p - jm.label_proba(t)[c]) for t, row in zip(sample, reference.predict_proba(sample)) for c, p in zip(reference.classes_, row))
    if worst > 1e-3:
        raise SystemExit(f"[train] portable export mismatch: max |Δp| = {worst:.2e}")
    print(f"[train] calibration: {config.CALIBRATION}")
    print(f"[train] {build_id}: {len(X)} rows, {len(word_vec.vocabulary_)} word + {len(char_vec.vocabulary_)} char features; "
          f"export fidelity max |Δp| = {worst:.1e}")
    print(f"[train] wrote {joblib_path.name} ({joblib_path.stat().st_size // 1024} KiB), {json_path.name} ({json_path.stat().st_size // 1024} KiB), model_manifest.json")


if __name__ == "__main__":
    main()
