import json

from training import config, preprocess


def _rows(n_variants=3):
    rows = []
    for i in range(30):
        word = "".join(chr(ord("a") + (i // 26 ** k) % 26) for k in range(3))
        base = f"Message about topic {word}alpha {word}beta {word}gamma {word}delta {word}omega"
        for v in range(n_variants):
            rows.append({"text": base + ["", " now", " today"][v], "label": ["safe", "suspicious", "scam"][i % 3], "category": "other", "source": "test", "language": "en"})
    return rows


def test_near_duplicates_never_cross_splits(tmp_path):
    src = tmp_path / "d.jsonl"
    src.write_text("\n".join(json.dumps(r) for r in _rows()))
    m = preprocess.run([src], tmp_path / "out", external=False)
    splits = {n: [json.loads(l) for l in (tmp_path / "out" / f"{n}.jsonl").read_text().splitlines()] for n in ("train", "val", "test")}
    groups = {n: {r["group"] for r in rows} for n, rows in splits.items()}
    assert not (groups["train"] & groups["test"]) and not (groups["train"] & groups["val"]) and not (groups["val"] & groups["test"])
    assert m["near_duplicate_groups"] == 30  # each family of 3 variants grouped together


def test_reproducible(tmp_path):
    src = tmp_path / "d.jsonl"
    src.write_text("\n".join(json.dumps(r) for r in _rows(1)))
    a = preprocess.run([src], tmp_path / "a", external=False)
    b = preprocess.run([src], tmp_path / "b", external=False)
    assert (tmp_path / "a" / "test.jsonl").read_text() == (tmp_path / "b" / "test.jsonl").read_text()
    assert a["data_sha256"] == b["data_sha256"]


def test_schema_validation(tmp_path):
    import pytest
    bad = tmp_path / "bad.csv"
    bad.write_text("text,label\nhello,maybe\n")
    with pytest.raises(preprocess.DatasetError, match="unknown label"):
        preprocess.run([bad], tmp_path / "o", external=False)
    bad.write_text("text,label,category\nhi,scam,aliens\n")
    with pytest.raises(preprocess.DatasetError, match="unknown category"):
        preprocess.run([bad], tmp_path / "o", external=False)


def test_text_cleanup_preserves_signals():
    t = preprocess.clean_text("Pay  ₹499\u0007 now:\n\n\n\nhttps://x.example/a?b=1")
    assert t == "Pay ₹499 now:\n\nhttps://x.example/a?b=1"
