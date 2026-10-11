#!/usr/bin/env python3
"""
Dataset ingestion → validation → normalisation → de-duplication → group-aware split.

  python ml/training/preprocess.py                       # all CSV/JSONL under ml/datasets/raw (except external/)
  python ml/training/preprocess.py --input path/a.csv path/b.jsonl

Schema (CSV header or JSONL keys): text, label, category, source, language
  label     ∈ safe | suspicious | scam
  category  ∈ config.CATEGORIES (default "other")
  language  ∈ en | hi | hinglish | mixed (default "en")

Outputs ml/datasets/processed/{train,val,test}.jsonl + split_manifest.json.

Leakage control: exact duplicates (after canonicalisation) are removed, and near-duplicates
(token Jaccard ≥ NEAR_DUPLICATE_JACCARD — e.g. the same campaign with a different amount or link)
are grouped so a group never spans two splits (StratifiedGroupKFold, fixed seed).
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
import unicodedata
from collections import Counter
from pathlib import Path

import regex as re
from sklearn.model_selection import StratifiedGroupKFold

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from training import config  # noqa: E402
from inference.preprocessing import tokenize  # noqa: E402

REQUIRED = ("text", "label")


class DatasetError(ValueError):
    pass


def read_rows(path: Path) -> list[dict]:
    if path.suffix == ".jsonl":
        rows = []
        for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as e:
                raise DatasetError(f"{path.name}:{i}: invalid JSON ({e.msg})") from None
        return rows
    if path.suffix == ".csv":
        with path.open(encoding="utf-8", newline="") as f:
            return list(csv.DictReader(f))
    raise DatasetError(f"unsupported file type: {path.name}")


def clean_text(text: str) -> str:
    """Light, signal-preserving cleanup for storage: NFC, normalised whitespace, no controls."""
    t = unicodedata.normalize("NFC", text)
    t = "".join(ch for ch in t if ch in "\n\t" or unicodedata.category(ch)[0] != "C" or ch in "​‌‍")
    t = re.sub(r"[ \t ]+", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def validate(row: dict, where: str) -> dict:
    missing = [k for k in REQUIRED if not str(row.get(k, "")).strip()]
    if missing:
        raise DatasetError(f"{where}: missing {missing}")
    label = str(row["label"]).strip().lower()
    if label not in config.LABELS:
        raise DatasetError(f"{where}: unknown label {label!r}")
    category = (str(row.get("category") or "other").strip().lower()) or "other"
    if category not in config.CATEGORIES:
        raise DatasetError(f"{where}: unknown category {category!r}")
    language = (str(row.get("language") or "en").strip().lower()) or "en"
    if language not in config.LANGUAGES:
        raise DatasetError(f"{where}: unknown language {language!r}")
    text = clean_text(str(row["text"]))
    if not text:
        raise DatasetError(f"{where}: empty text after cleanup")
    return {"text": text, "label": label, "category": category if label != "safe" else "other",
            "source": str(row.get("source") or "unknown").strip(), "language": language}


def canonical(text: str) -> str:
    """Key for exact-duplicate detection: tokens with numbers/URLs collapsed."""
    return " ".join(tokenize(text))


def group_near_duplicates(rows: list[dict], threshold: float, chunk: int = 512) -> list[int]:
    """Union-find over token-set Jaccard ≥ threshold, computed with chunked sparse products
    (intersection = A·Aᵀ on binary token matrices), so ~10k rows take seconds."""
    import numpy as np
    from scipy.sparse import csr_matrix

    vocab: dict[str, int] = {}
    indptr, indices = [0], []
    for r in rows:
        toks = {vocab.setdefault(t, len(vocab)) for t in tokenize(r["text"])}
        indices.extend(sorted(toks))
        indptr.append(len(indices))
    A = csr_matrix((np.ones(len(indices), dtype=np.float32), indices, indptr), shape=(len(rows), max(1, len(vocab))))
    sizes = np.asarray(A.sum(axis=1)).ravel()
    parent = list(range(len(rows)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for start in range(0, len(rows), chunk):
        inter = (A[start:start + chunk] @ A.T).tocoo()
        for i, j, v in zip(inter.row, inter.col, inter.data):
            gi = start + int(i)
            if gi < j:
                union = sizes[gi] + sizes[j] - v
                if union > 0 and v / union >= threshold:
                    parent[find(gi)] = find(int(j))
    roots: dict[int, int] = {}
    return [roots.setdefault(find(i), len(roots)) for i in range(len(rows))]


def read_uci_sms(path: Path) -> list[dict]:
    """UCI SMS Spam Collection v.1 (Almeida & Gómez Hidalgo, 2011; free use with attribution).
    ham → safe (real conversational SMS, contributors consented to publication);
    spam → suspicious (WEAK label: unsolicited marketing/prize SMS, not verified scams)."""
    rows = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if "\t" not in line:
            continue
        lab, text = line.split("\t", 1)
        rows.append({"text": text, "label": "safe" if lab == "ham" else "suspicious", "category": "other",
                     "source": "uci-sms-" + lab, "language": "en"})
    return rows


def split(rows: list[dict], groups: list[int], seed: int) -> tuple[list[int], list[int], list[int]]:
    labels = [r["label"] for r in rows]
    n_test = max(2, round(1 / config.TEST_FRACTION))
    outer = StratifiedGroupKFold(n_splits=n_test, shuffle=True, random_state=seed)
    rest_idx, test_idx = next(outer.split(rows, labels, groups))
    rest_labels = [labels[i] for i in rest_idx]
    rest_groups = [groups[i] for i in rest_idx]
    n_val = max(2, round((1 - config.TEST_FRACTION) / config.VAL_FRACTION))
    inner = StratifiedGroupKFold(n_splits=n_val, shuffle=True, random_state=seed + 1)
    tr, va = next(inner.split(rest_idx, rest_labels, rest_groups))
    return [int(rest_idx[i]) for i in tr], [int(rest_idx[i]) for i in va], [int(i) for i in test_idx]


def run(inputs: list[Path], out_dir: Path, seed: int = config.SEED, external: bool = True) -> dict:
    rows: list[dict] = []
    for p in inputs:
        for i, raw in enumerate(read_rows(p), 2):
            rows.append(validate(raw, f"{p.name}:{i}"))
    if external and config.EXTERNAL_UCI.exists():
        for i, raw in enumerate(read_uci_sms(config.EXTERNAL_UCI), 1):
            rows.append(validate(raw, f"uci:{i}"))
        inputs = [*inputs, config.EXTERNAL_UCI]

    seen: set[str] = set()
    unique = []
    for r in rows:
        key = canonical(r["text"])
        if key and key not in seen:
            seen.add(key)
            unique.append(r)
    dropped = len(rows) - len(unique)

    groups = group_near_duplicates(unique, config.NEAR_DUPLICATE_JACCARD)
    tr, va, te = split(unique, groups, seed)
    shared = ({groups[i] for i in tr} & {groups[i] for i in te}) | ({groups[i] for i in tr} & {groups[i] for i in va}) | ({groups[i] for i in va} & {groups[i] for i in te})
    if shared:
        raise DatasetError(f"leakage: {len(shared)} near-duplicate groups span splits")

    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = {"seed": seed, "inputs": [p.name for p in inputs], "rows_in": len(rows), "duplicates_dropped": dropped,
                "near_duplicate_groups": len(set(groups)), "splits": {}}
    for name, idx in (("train", tr), ("val", va), ("test", te)):
        with (out_dir / f"{name}.jsonl").open("w", encoding="utf-8") as f:
            for i in idx:
                f.write(json.dumps({**unique[i], "group": groups[i]}, ensure_ascii=False) + "\n")
        manifest["splits"][name] = {
            "rows": len(idx),
            "labels": dict(Counter(unique[i]["label"] for i in idx)),
            "languages": dict(Counter(unique[i]["language"] for i in idx)),
            "sources": dict(Counter(unique[i]["source"].split("-v")[0] for i in idx)),
        }
    digest = hashlib.sha256("\n".join(sorted(canonical(r["text"]) + "|" + r["label"] for r in unique)).encode()).hexdigest()
    manifest["data_sha256"] = digest
    (out_dir / "split_manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    return manifest


def default_inputs() -> list[Path]:
    return sorted(p for p in config.RAW_DIR.rglob("*") if p.suffix in (".csv", ".jsonl") and "external" not in p.parts)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", nargs="*", type=Path)
    ap.add_argument("--out", type=Path, default=config.PROCESSED_DIR)
    ap.add_argument("--seed", type=int, default=config.SEED)
    ap.add_argument("--no-external", action="store_true", help="ignore ml/datasets/raw/external (UCI SMS)")
    a = ap.parse_args()
    inputs = a.input or default_inputs()
    if not inputs:
        raise SystemExit(f"No datasets found under {config.RAW_DIR}. See ml/datasets/README.md.")
    m = run(inputs, a.out, a.seed, external=not a.no_external)
    print(json.dumps({k: m[k] for k in ("rows_in", "duplicates_dropped", "near_duplicate_groups", "splits")}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
