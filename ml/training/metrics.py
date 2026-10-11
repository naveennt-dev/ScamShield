"""Metric computation shared by train.py (cross-validation) and evaluate.py (held-out sets)."""
from __future__ import annotations

import numpy as np
from sklearn.metrics import (
    accuracy_score,
    confusion_matrix,
    precision_recall_fscore_support,
    roc_auc_score,
)


def compute_metrics(y_true: list[str], y_pred: list[str], proba: np.ndarray | None, classes: list[str]) -> dict:
    y_true = list(y_true)
    y_pred = list(y_pred)
    labels = [c for c in classes]
    p, r, f, support = precision_recall_fscore_support(y_true, y_pred, labels=labels, zero_division=0)
    macro = precision_recall_fscore_support(y_true, y_pred, labels=labels, average="macro", zero_division=0)
    cm = confusion_matrix(y_true, y_pred, labels=labels)

    out: dict = {
        "n": len(y_true),
        "accuracy": float(accuracy_score(y_true, y_pred)),
        "macro": {"precision": float(macro[0]), "recall": float(macro[1]), "f1": float(macro[2])},
        "perClass": {
            c: {"precision": float(p[i]), "recall": float(r[i]), "f1": float(f[i]), "support": int(support[i])}
            for i, c in enumerate(labels)
        },
        "confusionMatrix": {"labels": labels, "matrix": cm.tolist()},
    }

    # Security-centric rates (only meaningful for the safe/suspicious/scam label task).
    if set(["safe", "scam"]).issubset(labels):
        yt = np.array(y_true)
        yp = np.array(y_pred)
        scam = yt == "scam"
        safe = yt == "safe"
        out["security"] = {
            # Scams the model called "safe": the most dangerous error.
            "scamMissedAsSafeRate": float(np.mean(yp[scam] == "safe")) if scam.any() else None,
            # Scams not labelled "scam" (includes "suspicious").
            "falseNegativeRate": float(np.mean(yp[scam] != "scam")) if scam.any() else None,
            # Legitimate messages flagged as suspicious or scam.
            "falsePositiveRate": float(np.mean(yp[safe] != "safe")) if safe.any() else None,
            "scamMissedCount": int(np.sum(yp[scam] == "safe")),
        }

    if proba is not None and len(set(y_true)) > 1:
        try:
            if len(labels) == 2:
                pos = labels[1]
                out["rocAuc"] = float(roc_auc_score([1 if y == pos else 0 for y in y_true], proba[:, 1]))
            else:
                present = sorted(c for c in labels if c in set(y_true))  # sklearn requires sorted labels
                idx = [labels.index(c) for c in present]
                sub = proba[:, idx]
                sub = sub / np.clip(sub.sum(axis=1, keepdims=True), 1e-12, None)
                out["rocAucOvrMacro"] = float(
                    roc_auc_score(y_true, sub, multi_class="ovr", average="macro", labels=present)
                )
            if "scam" in labels:
                si = labels.index("scam")
                out["rocAucScamVsRest"] = float(roc_auc_score([1 if y == "scam" else 0 for y in y_true], proba[:, si]))
        except ValueError as e:  # e.g. a class missing from a small fold
            out["rocAucError"] = str(e)
    return out


def format_report(title: str, m: dict, disclaimer: str | None = None) -> str:
    lines = [f"# {title}", ""]
    if disclaimer:
        lines += [f"> **{disclaimer}**", ""]
    lines += [f"- Samples: {m['n']}", f"- Accuracy: {m['accuracy']:.3f}",
              f"- Macro precision / recall / F1: {m['macro']['precision']:.3f} / {m['macro']['recall']:.3f} / {m['macro']['f1']:.3f}"]
    for k in ("rocAuc", "rocAucOvrMacro", "rocAucScamVsRest"):
        if k in m:
            lines.append(f"- {k}: {m[k]:.3f}")
    if "security" in m:
        s = m["security"]
        lines += ["", "## Security error rates", ""]
        for k, v in s.items():
            lines.append(f"- {k}: {v if v is None or isinstance(v, int) else f'{v:.3f}'}")
    lines += ["", "## Per class", "", "| class | precision | recall | f1 | support |", "|---|---|---|---|---|"]
    for c, v in m["perClass"].items():
        lines.append(f"| {c} | {v['precision']:.3f} | {v['recall']:.3f} | {v['f1']:.3f} | {v['support']} |")
    labels = m["confusionMatrix"]["labels"]
    lines += ["", "## Confusion matrix (rows = true, cols = predicted)", "", "| | " + " | ".join(labels) + " |",
              "|---" * (len(labels) + 1) + "|"]
    for lab, row in zip(labels, m["confusionMatrix"]["matrix"]):
        lines.append(f"| **{lab}** | " + " | ".join(str(x) for x in row) + " |")
    return "\n".join(lines) + "\n"
