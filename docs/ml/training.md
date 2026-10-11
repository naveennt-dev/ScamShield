# Training

```bash
python3 -m venv ml/.venv && ml/.venv/bin/pip install -r ml/requirements.txt
npm run ml:fetch-data     # optional: UCI SMS corpus (public, attribution)
npm run ml:train          # preprocess → train → evaluate → TS parity fixture
npm run ml:test           # Python tests (preprocessing, inference, service, split)
```

## Procedure (`ml/training/train.py`)

1. Load `processed/train.jsonl` and `val.jsonl` (built by `preprocess.py`).
2. **Model selection on validation only** over `C ∈ {0.5, 1, 2, 4}` × external-weight ratio
   `{none, 3, 1, 0.5}`. Objective = macro-F1 + scam recall on the domain (synthetic) validation rows
   − 2 × false-positive rate on the real external "safe" validation rows.
   The selected configuration for the current model: **C = 0.5, external weight ratio = 0.5**.
   With only ~29 domain validation rows, this selection is noisy.
3. **Per-source sample weights**: without them, ~3 600 generic UCI SMS outvote ~130 domain rows and
   the model learned "phone number + call ⇒ suspicious", flagging genuine Indian bank alerts
   ("Not you? Call 1800…"). The ratio sets total external weight relative to domain weight.
4. **Final fit on the train split**; per-class **sigmoid calibration fitted on the validation split**
   (`config.CALIBRATION = "sigmoid"`; `"none"` instead refits on train+val and serves raw
   probabilities).
5. Category head on non-safe **domain** rows (categories with < 3 examples → `other`).
6. Export `scam_classifier.joblib`, portable `scam_classifier.json` (incl. calibration
   parameters) and `model_manifest.json` (name, version, build id, tokenizer version,
   probability type, SHA-256 of both files). Abort if the portable maths differ from sklearn by
   > 1e-3 (current: 5e-6).

The test split is never touched during training or selection.

## Versioning

`model_manifest.json`:

```json
{ "name": "scam-tfidf-logreg", "version": "1.1.0", "buildId": "1.1.0+20261007.906379c2",
  "tokenizerVersion": "v2", "probabilityType": "calibrated-sigmoid-on-validation", ... }
```

- `version` (semver, `config.MODEL_VERSION`): MAJOR = incompatible features/labels, MINOR =
  retrained on new data.
- `buildId` = version + date + data hash prefix → identical data ⇒ identical id.
- `tokenizerVersion` must match the code (Python and TS refuse mismatches).
- Every API response includes `model {name, version, buildId, backend}`.

Artifacts: the `.joblib` is git-ignored (regenerate with `npm run ml:train`; never accept pickles
from untrusted sources); the portable JSON (2.6 MB) and manifest are small enough to keep with the
code so the embedded fallback works out of the box.

## After retraining

`npm run ml:train` regenerates the parity fixture; then `npm test` (TS parity to 1e-9),
`npm run ml:test`, `npx tsx scripts/evaluate-system.ts`, and restart the ML service
(`scripts/local-stack.sh stop && scripts/local-stack.sh start`).
