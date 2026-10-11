# ScamShield — Production Architecture

Status as of 2026-10-07. "Implemented" means code + tests exist in this repository. See
`docs/production-readiness.md` for the gap list.

## 1. Overview

```
Browser (Next.js App Router UI, React Query)
   │  same-origin fetch, session cookie (better-auth)
   ▼
middleware.ts ── nonce CSP · CORS allow-list · optimistic auth redirect
   ▼
Route handlers  /api/v1/*   (withApi: request ID, origin/CSRF check, session, rate limit,
   │                         error envelope, metrics, structured logs)
   ▼
Application services  (src/lib/services)  settings · analysis · history · reports · stats · events
   ▼
Detection pipeline   (src/lib/detection/pipeline.ts)
   preprocess → [URL analysis ‖ intel lookup] → rules → ML → LLM (optional) → risk fusion
              → explanation + recommendations
   ▼
PostgreSQL (Prisma)                Redis (rate limits)           OpenRouter (LLM, optional)
```

The pipeline and services are plain TypeScript modules with injected dependencies; none of them
import Next.js. They can be lifted into a separate service (e.g. FastAPI calling a Node worker,
or a Node service) without changes to the detection logic.

## 2. Module map

| Path | Responsibility |
|---|---|
| `src/lib/schemas/` | Canonical Zod schemas & types shared by server and UI (`AnalysisResult`, request bodies) |
| `src/lib/config/env.ts` | Zod-validated server configuration (never imported by client code) |
| `src/lib/ai/` | Provider abstraction (`AIProvider`), OpenRouter client, model router, prompts, LLM output schema, typed errors |
| `src/lib/detection/preprocess.ts` | NFKC, invisible-char stripping, homoglyph folding, URL extraction |
| `src/lib/detection/rules/` | Deterministic rule engine (≈35 rules + 5 combos, negation-aware) |
| `src/lib/detection/ml/` | TF-IDF + LR inference (pure TS), tokenizer parity with Python |
| `src/lib/detection/fingerprint.ts` | SHA-256 canonical fingerprint + 64-bit SimHash (LSH bands) |
| `src/lib/detection/explain.ts` | Deterministic reasons, explanation, recommendations |
| `src/lib/risk/` | Risk fusion engine, thresholds |
| `src/lib/url/` | Extraction, static analysis, SSRF guard, safe redirect resolver, reputation interface |
| `src/lib/email/` | Email header/metadata analysis (attachments by name only) |
| `src/lib/ocr/` | Image validation (magic bytes, header dimensions), OCR provider abstraction (tesseract.js) |
| `src/lib/intel/` | Scam intelligence from user reports (patterns, domain reputation) |
| `src/lib/rate-limit/` | Fixed-window limiter: Redis store (prod) + memory store (dev/test) |
| `src/lib/api/` | Envelope, errors, bounded body reading, origin/CORS policy, route wrapper |
| `src/lib/observability/` | JSON logger with redaction, Prometheus metrics, error-reporter hook |
| `src/lib/services/` | Application services (DB access lives here) |
| `ml/` | Python training/evaluation/inference pipeline |

## 3. Detection pipeline

| Stage | Responsibility | Fails how |
|---|---|---|
| Preprocess | Normalise text, defeat zero-width/homoglyph obfuscation, extract ≤20 URLs (incl. defanged) | never |
| URL analysis | Static heuristics (brand impersonation, typosquat, homograph, IP hosts, shorteners, TLDs, executables, userinfo tricks) + reputation providers + optional SSRF-safe redirect resolution | warning, URLs unscored |
| Intel lookup | Exact fingerprint / SimHash near-duplicate match against reported patterns | silently skipped |
| Rules | Intent-based patterns (request verb near sensitive object, threat + deadline, …) with negation handling; noisy-OR score | never (faulty rule is skipped) |
| ML | TF-IDF (word 1–2 grams) + multinomial LR → P(safe/suspicious/scam) and category | marked unavailable |
| LLM | OpenRouter via model router (primary → fallback → fast), Zod-validated JSON | marked unavailable, warning |
| Fusion | Confidence-weighted mean + explicit floors/boosts (see §4) | never |
| Explain | Plain-language reasons and actions from deterministic signals; LLM text only as "AI summary" | never |

**Responsibility split** — ML: classification probability and category. Rules: high-confidence
indicators (OTP/PIN/CVV requests, remote access, APKs). URL intelligence: link risk. LLM: semantic
reasoning, summary, extra recommendations. The LLM is never the sole decision-maker.

## 4. Risk fusion

```
wᵢ   = configured_weightᵢ × confidenceᵢ        (seed ML model: confidence × 0.5)
base = Σ wᵢ·scoreᵢ / Σ wᵢ                       over available sources only
final = max(base,
            0.8 × max(rule score, URL score),    deterministic floor
            45 if a critical indicator fired,     OTP/PIN/CVV/password/remote-access/APK/QR
            30 if prompt injection detected,
            2nd-highest score if ≥2 sources ≥ 60) corroboration boost
```

Default weights (env-configurable): ML 0.35, rules 0.30, URL 0.20, LLM 0.15. If the content tries
to instruct an AI and the LLM rates it lower than the deterministic baseline, the LLM signal is
discarded. Every contribution and adjustment is returned in the API response (`signals`,
`adjustments`) and shown in the UI ("How the score was calculated").

Levels: 0–29 SAFE · 30–59 SUSPICIOUS · 60–84 HIGH RISK · 85–100 CRITICAL; `classification` is
`scam` from 60.

## 5. LLM layer

- `AIProvider` interface; `OpenRouterScamProvider` is the only implementation. Provider-specific
  code is confined to `src/lib/ai/openrouter.ts`.
- Models come from `SCAM_PRIMARY_MODEL`, `SCAM_FALLBACK_MODEL`, `SCAM_FAST_MODEL` — no model is
  hard-coded. Changing models is a config change.
- Router: per-call timeout, ≤`OPENROUTER_MAX_RETRIES` retries per model with exponential backoff
  + jitter, honours `Retry-After` up to 5 s (longer → next model), total budget
  `OPENROUTER_TOTAL_BUDGET_MS`, JSON-mode downgrade for models that reject `response_format`,
  circuit breaker (3 failures → skip model 60 s), chain abort on 401/402.
- Output: fences/`<think>` stripped, JSON parsed, Zod-validated (riskScore 0–100, confidence 0–1,
  enums, bounded arrays/strings); recommendations containing URLs/phone numbers are dropped.

## 6. Data model

better-auth tables (`user`, `session`, `account`, `verification`) are unchanged. Added:
`user_settings`, `scam_analysis`, `scam_indicator`, `url_analysis`, `scam_report`, `scam_pattern`,
`analysis_event` (migration `20261007165301_scamshield_domain_models`).

Privacy by design:
- Raw content is never stored. `scam_analysis.contentPreview` is a masked (digits, emails, UPI IDs)
  240-char preview, and only if the user allows it. URLs are stored as hostname/domain + SHA-256.
- Anonymous analyses are not stored.
- `expiresAt` per analysis (user-selectable 7–365 days); `/api/v1/cron/retention` deletes
  expired analyses, events older than `EVENT_RETENTION_DAYS`, and stale unverified patterns.
- Users can delete one scan or all history.

## 7. Scam intelligence

Reports are stored once per (user, fingerprint) and aggregated into `scam_pattern` rows
(message fingerprints with SimHash bands, and registrable domains). A pattern influences scoring
only after ≥2 distinct reporters (or reviewer status `TRUSTED`), with confidence capped at 0.7
for unverified patterns and signal weight ≤ 0.5 × confidence. Rejected patterns are ignored. No
report content or reporter identity is exposed to other users. There is **no reviewer UI yet**:
`status` must be changed in the database.

## 8. Request handling

`withApi` (src/lib/api/handler.ts) wraps every v1 route: request ID (accepts a safe inbound
`X-Request-Id`), cross-site write rejection, session lookup, rate limiting (per scope and tier,
per-minute and per-day windows), body size limits, Zod validation, error envelope without stack
traces, metrics, and one structured log line per request.

## 9. Frontend

Route group `(dashboard)` with a server-side session check and an `AppShell` (sidebar on desktop,
menu on mobile): Dashboard, Scan Message/URL/Screenshot/Email, History (+ detail), Scam Reports,
Settings. All statistics come from `/api/v1/stats` (real data; empty states otherwise).
Suspicious URLs are rendered as text, never as links.
