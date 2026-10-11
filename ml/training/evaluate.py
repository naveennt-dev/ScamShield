#!/usr/bin/env python3
"""
Evaluate the trained model on the held-out TEST split (never used for training or selection),
plus an optional EXTERNAL benchmark on real public messages.

  python ml/training/evaluate.py

Reports (ml/evaluation/reports/<build>-*.{json,md}):
  • accuracy, precision, recall, F1 (per class + macro), confusion matrix
  • explicit false positives / false negatives (scam → not scam, scam → safe)
  • calibration analysis: Brier score + expected calibration error (ECE) for raw probabilities,
    and for a sigmoid-calibrated variant fitted on the validation split (investigation only)
  • external: UCI SMS Spam Collection (if downloaded to ml/datasets/raw/external/) —
    false-positive rate on 4,827 real "ham" messages; flag rate on spam (a proxy, NOT scam recall)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from inference.model_loader import SklearnModel  # noqa: E402
from training import config  # noqa: E402
from training.metrics import compute_metrics, format_report  # noqa: E402
from training.train import load_split  # noqa: E402


def calibration_stats(y_true: list[str], proba: np.ndarray, classes: list[str], bins: int = 5) -> dict:
    onehot = np.array([[1.0 if y == c else 0.0 for c in classes] for y in y_true])
    brier = float(np.mean(np.sum((proba - onehot) ** 2, axis=1)))
    conf = proba.max(axis=1)
    correct = np.array([classes[i] == y for i, y in zip(proba.argmax(axis=1), y_true)], dtype=float)
    ece = 0.0
    edges = np.linspace(0, 1, bins + 1)
    for lo, hi in zip(edges[:-1], edges[1:]):
        mask = (conf > lo) & (conf <= hi)
        if mask.any():
            ece += mask.mean() * abs(correct[mask].mean() - conf[mask].mean())
    return {"brier": round(brier, 4), "ece": round(float(ece), 4), "meanConfidence": round(float(conf.mean()), 4),
            "accuracy": round(float(correct.mean()), 4)}


def load_uci() -> tuple[list[str], list[str]] | None:
    if not config.EXTERNAL_UCI.exists():
        return None
    labels, texts = [], []
    for line in config.EXTERNAL_UCI.read_text(encoding="utf-8", errors="replace").splitlines():
        if "\t" in line:
            l, t = line.split("\t", 1)
            labels.append(l)
            texts.append(t)
    return labels, texts


def main() -> None:
    model = SklearnModel.load(config.MODELS_DIR)
    build = model.manifest["buildId"]
    pipe = model.label_estimator  # calibrated if the model was trained with calibration
    raw_pipe = model.label_pipeline
    classes = [str(c) for c in pipe.classes_]
    test = load_split("test")
    Xte, yte = [r["text"] for r in test], [r["label"] for r in test]

    proba = pipe.predict_proba(Xte)
    pred = [classes[i] for i in proba.argmax(axis=1)]
    order = [c for c in config.LABELS if c in classes]
    proba_ordered = proba[:, [classes.index(c) for c in order]]
    metrics = compute_metrics(yte, pred, proba_ordered, order)

    errors = [{"text": t, "true": y, "pred": p, "language": r["language"]} for t, y, p, r in zip(Xte, yte, pred, test) if y != p]
    metrics["falseNegatives"] = [e for e in errors if e["true"] == "scam" and e["pred"] != "scam"]
    metrics["falsePositives"] = [e for e in errors if e["true"] == "safe" and e["pred"] != "safe"]
    metrics["counts"] = {"falseNegativesScam": len(metrics["falseNegatives"]),
                         "scamMissedAsSafe": sum(e["pred"] == "safe" for e in metrics["falseNegatives"]),
                         "falsePositivesSafe": len(metrics["falsePositives"]), "testRows": len(yte)}

    # Per-source breakdown so thousands of UCI rows cannot hide performance on the scam data.
    by_source = {}
    for src in sorted({r["source"].split("-v")[0] if r["source"].startswith("synthetic") else r["source"] for r in test}):
        idx = [i for i, r in enumerate(test) if (r["source"].split("-v")[0] if r["source"].startswith("synthetic") else r["source"]) == src]
        ys, ps = [yte[i] for i in idx], [pred[i] for i in idx]
        by_source[src] = {"rows": len(idx), "accuracy": round(sum(a == b for a, b in zip(ys, ps)) / len(idx), 4),
                          "predicted": {c: ps.count(c) for c in order}, "true": {c: ys.count(c) for c in order}}
    metrics["bySource"] = by_source

    # Calibration: served probabilities vs raw LR probabilities on the TEST split.
    cal = {
        "served": model.manifest.get("probabilityType"),
        "servedStats": calibration_stats(yte, proba, classes),
        "rawStats": calibration_stats(yte, raw_pipe.predict_proba(Xte), [str(c) for c in raw_pipe.classes_]),
    }
    cal["note"] = f"{len(yte)} test rows — calibration estimates are very noisy at this size."
    metrics["calibration"] = cal

    # External benchmark on the FULL UCI corpus is only meaningful when UCI was NOT used for training.
    uci = load_uci() if not any(s.startswith("uci-") for s in model.manifest["trainingData"].get("sources", [])) else None
    if uci:
        labels, texts = uci
        upred = pipe.predict(texts)
        ham = [p for l, p in zip(labels, upred) if l == "ham"]
        spam = [p for l, p in zip(labels, upred) if l == "spam"]
        metrics["externalUciSms"] = {
            "hamMessages": len(ham),
            "hamFlagged": int(sum(p != "safe" for p in ham)),
            "hamFalsePositiveRate": round(sum(p != "safe" for p in ham) / len(ham), 4),
            "hamPredictedScam": int(sum(p == "scam" for p in ham)),
            "spamMessages": len(spam),
            "spamFlaggedRate": round(sum(p != "safe" for p in spam) / len(spam), 4),
            "note": "ML model only (no rules). Spam ≠ scam: the spam flag rate is a proxy, not scam recall.",
        }

    config.REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    # Note: build ids contain dots, so never use Path.with_suffix here.
    json_path = config.REPORTS_DIR / f"{build}-test.json"
    md_path = config.REPORTS_DIR / f"{build}-test.md"
    json_path.write_text(json.dumps({"model": model.manifest, **metrics}, indent=2, ensure_ascii=False))
    md = format_report(f"Test-split evaluation — {build}", metrics,
                       "Mixed data: hand-written synthetic scam/safe/suspicious examples + UCI SMS (ham=safe, spam=suspicious weak label). See per-source results; NOT a measure of real-world scam detection accuracy.")
    md += f"\n## Per source\n\n```\n{json.dumps(by_source, indent=2)}\n```\n"
    md += "\n## Errors\n\n" + "\n".join(f"- [{e['true']}→{e['pred']}] ({e['language']}) {e['text'][:110]}" for e in errors) + "\n"
    md += f"\n## Calibration\n\n```\n{json.dumps(cal, indent=2)}\n```\n"
    if uci:
        md += f"\n## External: UCI SMS Spam Collection (real public SMS)\n\n```\n{json.dumps(metrics['externalUciSms'], indent=2)}\n```\n"
    md_path.write_text(md)
    print(json.dumps({k: metrics[k] for k in ("accuracy", "macro", "counts", "bySource", "calibration")} | ({"external": metrics.get("externalUciSms")} if uci else {}), indent=2))


if __name__ == "__main__":
    main()
