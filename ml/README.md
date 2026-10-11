# ScamShield ML (Phase 3)

```
ml/
├── datasets/  raw/ (inputs; raw/external/ = downloaded, git-ignored) · processed/ (generated) · eval/ (held-out scenarios)
├── training/  config.py · preprocess.py · train.py · evaluate.py · metrics.py
├── inference/ preprocessing.py (shared!) · model_loader.py · predict.py · service.py (FastAPI, 127.0.0.1)
├── models/    scam_classifier.joblib (git-ignored) · scam_classifier.json · model_manifest.json
├── evaluation/reports/
└── tests/     pytest: preprocessing · inference · service · split
```

```bash
python3 -m venv ml/.venv && ml/.venv/bin/pip install -r ml/requirements.txt
npm run ml:fetch-data   # optional public UCI SMS corpus
npm run ml:train        # preprocess → train → evaluate → TS parity fixture
npm run ml:test         # Python tests
npm run ml:service      # local inference service on 127.0.0.1:8765
```

Training never runs in production; the app only loads artifacts. Docs: `docs/ml/*.md`.

**No production-quality accuracy is claimed**: scam-domain data is synthetic and small
(see `docs/ml/evaluation.md`).
