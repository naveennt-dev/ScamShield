# Production Readiness — 2026-10-07

Honest status of ScamShield after the upgrade. "Implemented" = code exists in this repository and
is exercised by automated tests unless noted.

## Validation results (this commit)

| Check | Result |
|---|---|
| `npm install` | OK |
| `npx prisma generate` / `npx prisma validate` / `prisma migrate status` | OK / valid / up to date |
| `npm run lint` (ESLint 9, next/core-web-vitals + typescript) | 0 errors, 0 warnings |
| `npm run typecheck` (strict) | OK |
| `npm run build` | OK, no warnings (type errors no longer ignored) |
| `npm test` (Vitest: unit + security + integration on PostgreSQL + Redis) | 13 files, **234 tests passed** |
| `npm run test:e2e` (Playwright, production build, desktop + mobile) | **10 passed** |
| `npm audit` | 0 critical; remaining high/moderate are build/dev-time only (see audit doc) |

## Implemented

- Repository audit (`docs/architecture/current-state.md`) and bug/security fixes listed there.
- Shared Zod schemas/types for analysis results and requests (`src/lib/schemas`).
- OpenRouter provider behind `AIProvider`; model router with primary/fallback/fast chain, timeouts,
  bounded retries, exponential backoff + jitter, Retry-After, total budget, JSON-mode downgrade,
  circuit breaker, typed errors, Zod-validated output; no hard-coded model; request IDs.
- Deterministic rule engine (≈35 intent-based, negation-aware rules + 5 combos), incl. prompt
  injection and obfuscation detection.
- ML baseline: Python training (TF-IDF + LR, label + category heads), evaluation with security
  metrics, reference inference, JSON export with fidelity check, TypeScript inference with
  cross-language parity test.
- Risk fusion engine: configurable weights, confidence weighting, deterministic floors, injection
  guard, corroboration boost, explainable contributions/adjustments.
- Versioned API (`/api/v1/analyze/{message,url,image,email}`, `history`, `reports`, `stats`,
  `settings`, `health`, `metrics`, `cron/retention`) with a uniform envelope; (legacy `/api/scam` removed)
  kept with deprecation headers.
- Database models + migration (settings, analyses, indicators, URL analyses, reports, patterns,
  events) with indexes, retention expiry and cleanup job.
- History (paginated, filterable, per-item and bulk delete), user settings (preview storage,
  retention, LLM opt-out).
- URL extraction (incl. defanged/bare/IP), static URL analysis, SSRF-safe redirect resolver
  (opt-in), reputation provider interface with internal-reports implementation.
- Screenshot analysis: content-sniffed validation, OCR provider abstraction, tesseract.js provider.
- Email analysis: sender/display-name/reply-to/lookalike checks, SPF/DKIM/DMARC parsing,
  attachment metadata risk; no attachment content accepted.
- Scam reporting + intelligence: fingerprints, SimHash near-duplicates (LSH bands), distinct
  reporter counting, thresholds and caps.
- Rate limiting (Redis + memory fallback) per scope and tier.
- Security headers (nonce CSP, HSTS, etc.), CORS allow-list, CSRF origin check, body limits.
- Structured logging with redaction, Prometheus metrics endpoint, analysis-event audit table,
  startup configuration warnings, example alert rules.
- Dashboard UI: Dashboard, Scan Message/URL/Screenshot/Email, History (+detail), Scam Reports,
  Settings; real stats with empty states; responsive.
- Documentation set under `docs/`, README, `.env.example`, `docker-compose.yml` (local deps).

## Partially implemented

| Item | What exists | What is missing |
|---|---|---|
| ML model quality | Working pipeline and a seed model | A real labelled dataset; held-out evaluation; threshold calibration. The seed model is down-weighted and flagged in every result |
| Transformer/embedding stage | `ScamClassifier` interface only | Not implemented (unused prototype removed) |
| Domain reputation | Interface + internal crowd-report provider | External feeds (Google Safe Browsing, PhishTank, etc.) |
| Observability | Logs, per-instance Prometheus metrics, error-reporter hook, alert examples | Sentry SDK not installed; no OTLP export for serverless; no Grafana dashboard JSON |
| Scam intelligence | Aggregation, thresholds, statuses | Reviewer/admin UI to confirm or reject patterns (status changes require SQL) |
| Premium tier | Rate-limit tier exists | No billing or plan assignment (all users are "authenticated") |
| OCR | English, tesseract.js | Other languages (Hindi etc.); self-hosted language data by default |
| E2E auth | Email/password test auth | Google OAuth flow not automated |

## Not implemented

- FastAPI extraction of services (boundaries are prepared; code is TypeScript).
- Vector-embedding similarity search for scam patterns.
- Admin dashboard, moderation tools, abuse reporting workflow.
- Multi-language detection (rules/ML are English/Hinglish-oriented; Devanagari ignored by ML).
- MFA, account deletion UI (cascade deletes exist at the DB level), data export.
- Load/performance testing, external penetration test.

## Known limitations

- No accuracy figures for real traffic exist. Seed CV numbers (accuracy 0.733, macro-F1 0.568,
  7.3% scams missed as safe on 120 examples) are not representative.
- Rules are hand-weighted heuristics; weights should be tuned on labelled data.
- The `suspicious` class is poorly learned by the seed model (recall 0.05).
- In-process metrics are per instance.
- LLM quality/latency depends on whichever free models are configured; free models change often.
- Previews mask numbers, emails and UPI IDs but not names or postal addresses.

## Required environment variables (production)

`DATABASE_URL`, `BETTER_AUTH_SECRET` (≥32 chars), `BETTER_AUTH_URL` (https), `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `REDIS_URL`, `CRON_SECRET`.
Recommended: `OPENROUTER_API_KEY`, `SCAM_PRIMARY_MODEL`, `SCAM_FALLBACK_MODEL`, `SCAM_FAST_MODEL`,
`METRICS_TOKEN`. Full list: `.env.example`.

## Required external services

PostgreSQL 14+, Redis-compatible store, Google OAuth client. Optional: OpenRouter, Prometheus/
Grafana, Sentry, a scheduler for the retention job (Vercel Cron is preconfigured).

## Security considerations

See `docs/security/threat-model.md`, `docs/security/ssrf.md` and
`docs/security/audit-2026-10-07.md`. Key operator responsibilities: set `TRUST_PROXY_HEADERS`
correctly, keep `AUTH_ENABLE_EMAIL_PASSWORD=false`, keep `URL_FETCH_ENABLED=false` unless needed
(and add network egress restrictions if enabled), disclose LLM data sharing to users, schedule a
Next 16 / Prisma 7 upgrade to clear build-time advisories.

## Testing status

Unit, security, integration (real Postgres + Redis) and E2E (desktop + mobile) suites pass; all 18
mandatory scenarios from the specification are mapped to tests in `docs/testing/test-plan.md`.
Not tested automatically: Google OAuth, live OpenRouter (verified manually against an
OpenAI-compatible stub), load.

## Deployment requirements

Node 20.11+, `npx prisma migrate deploy` before release, environment as above, TLS termination,
daily retention cron, Redis reachable from all instances. Procedure: `docs/deployment/production.md`.

## Verdict

Suitable for a **staged beta** with monitoring. Not yet suitable to market as an accurate scam
detector: obtain a labelled dataset, evaluate the full system, calibrate thresholds, and add a
review workflow for crowd reports first.
