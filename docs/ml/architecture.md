# ML Architecture (Phase 3)

```
                 TRAINING (offline, Python)                         PRODUCTION (local, no training)
ml/datasets/raw/** ─► training/preprocess.py ─► processed/{train,val,test}.jsonl
                                    │
                         training/train.py ──► ml/models/scam_classifier.joblib ──► inference/service.py (FastAPI, 127.0.0.1:8765)
                                    │          ml/models/scam_classifier.json  ──┐            ▲ POST /predict
                                    │          ml/models/model_manifest.json     │            │
                         training/evaluate.py ─► ml/evaluation/reports/          │   Next.js API (127.0.0.1:3000)
                                                                                 └─► embedded fallback (TS, same maths)
```

## Components

| Path | Role |
|---|---|
| `ml/inference/preprocessing.py` | **Single source of truth** for text normalisation + features, imported by training and inference. Ported 1:1 to `src/lib/detection/ml/tokenizer.ts`. |
| `ml/training/config.py` | Every tunable (paths, seed, split fractions, grids, calibration). |
| `ml/training/preprocess.py` | Ingestion, schema validation, dedup, near-duplicate grouping, group-aware split. |
| `ml/training/train.py` | Model selection on validation, final fit, calibration, artifact export + fidelity check. |
| `ml/training/evaluate.py` | Held-out test metrics, FN/FP lists, calibration stats, per-source breakdown. |
| `ml/inference/model_loader.py` | SHA-256-verified loading of artifacts; pure-JSON reference model. |
| `ml/inference/predict.py` | `Predictor` (production inference) + parity-fixture generator. |
| `ml/inference/service.py` | Local FastAPI service (Pydantic validation, loopback-only). |
| `src/lib/detection/ml/` | TS: service client (Zod), embedded fallback, backend selection. |
| `scripts/evaluate-system.ts` | Evaluates the fused engine (rules + ML + URL), not just the model. |

## Model

- Features: word unigrams + bigrams (`TfidfVectorizer`, sublinear TF, L2, min_df 2) ⊕ in-word
  character 3–5-grams (max 12 000) — robust to spelling tricks (`acc0unt`, `verlfy`).
- Classifier: multinomial `LogisticRegression`, `class_weight="balanced"`, per-source sample weights.
- Heads: label (`safe | suspicious | scam`) and category (non-safe domain rows only).
- Calibration: per-class sigmoid (Platt) fitted on the validation split; **served probabilities are
  calibrated** (`model_manifest.json → probabilityType`). They are still model confidence scores on
  this data distribution — not guaranteed real-world frequencies.
- Size: ~21k features; joblib 3.6 MB, JSON 2.6 MB; ~0.1 ms/prediction in TS, a few ms via the service.

## Preprocessing (signal-preserving)

NFKC → strip invisible/bidi characters → lowercase → typed placeholders instead of deletion:

| Input | Becomes |
|---|---|
| `https://sbi-kyc-update.xyz/login` | `urltoken sbi kyc update tld_xyz` (+ `shortlink` for shorteners) |
| `help@scam.io` | `emailtoken` |
| `₹499`, `Rs 4,999`, `25 lakh` | `moneytoken` |
| `+91 98765 43210` (≥ 8 digits) | `phonetoken` |
| `5%` | `pcttoken` |
| other digits | `numtoken` |

Tokens are runs of Unicode letters **and combining marks** (`[\p{L}\p{M}_]+`), so Devanagari
words keep their vowel signs. The example from the spec,
`"Your account will be blocked! Pay ₹499 now: https://fake-example.com"`, keeps
`blocked, pay, moneytoken, now, urltoken, fake, example, tld_com` (tested).

## Inference & backends

`ML_BACKEND`:
- `auto` (default) — Python service; on failure, the embedded TS model (identical maths, parity-tested
  to 1e-9) and a 30 s cool-down before retrying the service.
- `service` — service only; failure ⇒ ML unavailable (rules + URL still produce a result).
- `embedded` — TS only.

Every prediction carries `model {name, version, buildId}` and the backend that served it; the API
response exposes this as `model` (+ `processingTimeMs`).

## Security

- Service binds loopback only (refuses non-loopback `ML_SERVICE_HOST`); `ML_SERVICE_URL` must be a
  loopback URL (config validation). No docs/OpenAPI endpoints.
- Strict Pydantic request model (unknown fields rejected), 10 000-char text limit, 64 KB body limit,
  structured errors, no tracebacks; logs record length/latency/label only — never text.
- `joblib` files can execute code when loaded: the loader only loads from the models directory and
  only if the SHA-256 matches `model_manifest.json` (tampering test included).
- The TS client validates the service response with Zod and checks probability consistency.

## Multilingual

Tokenisation is Unicode-safe for Hindi and Hinglish, but the **training data has only 30
Hindi/Hinglish rows**, so ML quality in those languages is unmeasured/weak. The rule engine carries
Hindi/Hinglish detection today (see `docs/detection/rules.md`). Planned: more Hindi/Hinglish data;
a multilingual sentence-embedding stage (not implemented; the unused prototype was removed).
