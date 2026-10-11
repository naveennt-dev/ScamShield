# Phase 3 — Local ML + Scam Detection Engine

```
Mac: ScreenCaptureKit → Vision OCR → text
        │ ScamShieldAPI (unchanged)
        ▼
Next.js local API (127.0.0.1:3000) ── POST /api/v1/analyze/message
        │
        ├─ preprocess (NFKC, invisible chars, homoglyphs, URL extraction)
        ├─ Rule Detection Engine        src/lib/detection/rules/*.ts  (EN / Hindi / Hinglish)
        ├─ Local ML classifier          Python service 127.0.0.1:8765 (joblib)  ─fallback→ embedded TS (JSON)
        ├─ static URL analysis          (no fetching)
        ▼
Local Risk Engine (src/lib/detection/risk-engine.ts) → score · level · category · reasons · actions
        ▼
Result on Mac (Why + What to do)          LLM / OpenRouter: disabled (Phase 4)
```

Works with **no API key and no internet**.

## 1. Audit of Phases 1–2 (before changes)

- macOS scanner, OCR, `ScannerCoordinator` and `ScamShieldAPI` worked; the API client already
  targeted `/api/v1/analyze/message`. No Phase 2 code needed rewriting.
- The backend already contained (from the pre-phase web upgrade) a rule engine in one file, a seed
  TF-IDF model trained on 120 hand-written rows and evaluated only in TypeScript, and an LLM layer
  that defaulted to *enabled* (inactive only because no key was set).
- Gaps for Phase 3: no Python inference service, no proper dataset pipeline/splits, model never
  tested on real messages, no Hindi/Hinglish support (tokenizer dropped Devanagari), thresholds not
  configurable, rules not modular, LLM not explicitly off.
- Bugs found during Phase 3: email addresses tokenised as URLs; `bank.impersonation_cta` fired on UPI
  handles (`zomato@icici`); `evaluate.py` report names collapsed (`Path.with_suffix` on dotted build
  ids); `train_embeddings.py` imported deleted modules; the scanner card took keyboard focus, so a
  Space typed in another app could hit its ✕ (diagnosed from recorded event types).

## 2. What changed

| Area | Change |
|---|---|
| ML layout | `ml/{datasets/{raw,processed,eval},training/{config,preprocess,train,evaluate,metrics},inference/{preprocessing,model_loader,predict,service},models,tests}` |
| Preprocessing | v2 shared module: signal-preserving typed tokens, Unicode letters + marks (Hindi), word 1–2-grams + char 3–5-grams; ported 1:1 to TS (parity to 1e-9) |
| Data | 194 hand-written rows (EN/HI/Hinglish, adversarial) + public UCI SMS (ham → safe, spam → weak suspicious); dedup, near-duplicate groups, group-aware 70/15/15 split, seed 42 |
| Model | TF-IDF + LR, per-source weights, selection on validation, sigmoid calibration on validation, category head, joblib + portable JSON + manifest with SHA-256 |
| Service | FastAPI on 127.0.0.1:8765, Pydantic validation, limits, structured errors, no text logging, integrity-checked loading |
| Integration | `src/lib/detection/ml/` service client (Zod), embedded fallback, `ML_BACKEND=auto|service|embedded`, cool-down |
| Rules | split into 15 family modules + combos; Hindi/Hinglish patterns; negation before/after verbs in 3 languages; danda boundary |
| Risk engine | moved to `src/lib/detection/risk-engine.ts`; configurable thresholds; uncorroborated-ML cap |
| Response | adds `model {name, version, buildId, backend}` and `processingTimeMs` |
| LLM | `LLM_ENABLED` default **false** |
| Mac | result card shows "Why" (≤ 3 reasons) + actions; Phase 3 wording; card no longer steals focus while scanning |
| Ops | `scripts/local-stack.sh` (loopback-only stack, Next.js telemetry off), `scripts/offline-check.sh`, `scripts/evaluate-system.ts`, npm `ml:*` scripts |

## 3. Running

```bash
npm install && npm run build
python3 -m venv ml/.venv && ml/.venv/bin/pip install -r ml/requirements.txt
npm run ml:fetch-data && npm run ml:train      # optional retrain (artifacts are committed except .joblib)
scripts/local-stack.sh start                    # ML service + API on 127.0.0.1
macos/scripts/build-app.sh && open macos/build/ScamShield.app
```

Tests: `npm test` (TS), `npm run ml:test` (Python), `macos/scripts/test.sh` (Swift),
`EXPECT_BACKEND=1 macos/scripts/smoke-test.sh` (app), `scripts/offline-check.sh` (offline).

## 4. Privacy

Nothing leaves the Mac: OCR on device, analysis on 127.0.0.1, LLM disabled, Next.js telemetry
disabled by the stack script. The ML service never logs message text (length/latency/label only).
Screenshots are never stored; anonymous analyses (the Mac app) are not persisted; the backend keeps
only minimal event metadata. Egress check: sockets of the Next.js, ML-service and ScamShield
processes are sampled during the offline check — any non-loopback connection fails it.

## 5. Docs

`docs/ml/{architecture,dataset,training,evaluation}.md`, `docs/detection/rules.md`,
`docs/phases/phase-3-completion.md`.
