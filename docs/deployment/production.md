# Production Deployment

## Required services

| Service | Required | Notes |
|---|---|---|
| PostgreSQL 14+ | yes | Neon/RDS/Cloud SQL. Use a pooled URL on serverless. |
| Redis-compatible store | yes for production | Redis/Valkey/Upstash (TCP `rediss://`). Without it rate limits are per-instance. |
| OpenRouter account | optional | Without it ScamShield runs in deterministic mode (rules + ML + URL). |
| Google OAuth client | yes (sign-in) | Redirect URI: `https://<domain>/api/auth/callback/google` |
| Prometheus / Grafana | optional | Scrape `/api/v1/metrics` with the bearer token. |
| Sentry | optional | Integration point only (see below). |

## Environment

Copy `.env.example` and set at least:

```
DATABASE_URL, BETTER_AUTH_SECRET (≥32 chars), BETTER_AUTH_URL=https://<domain>,
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIS_URL, CRON_SECRET
```
Recommended: `OPENROUTER_API_KEY` + `SCAM_PRIMARY_MODEL` / `SCAM_FALLBACK_MODEL` / `SCAM_FAST_MODEL`,
`METRICS_TOKEN`, `CORS_ALLOWED_ORIGINS` (only if another origin must call the API).
Keep `AUTH_ENABLE_EMAIL_PASSWORD=false` in production.

`instrumentation.ts` logs `production_config_warning` events at startup for missing Redis, short
secrets, missing cron secret, etc. — check the logs after each deploy.

## Choosing OpenRouter models (free tier)

1. Open https://openrouter.ai/models, filter by price = 0, prefer models that support
   `response_format` / JSON output and have recent uptime.
2. Set three *different* providers' models so one outage doesn't take out the chain:
   ```
   SCAM_PRIMARY_MODEL=<vendor-a>/<model>:free
   SCAM_FALLBACK_MODEL=<vendor-b>/<model>:free
   SCAM_FAST_MODEL=<vendor-c>/<small-model>:free
   ```
3. Redeploy (or restart). No code changes are needed.
4. Free models have shared per-account rate limits and may be withdrawn; the router moves on
   immediately on long `Retry-After` and falls back to deterministic analysis. Watch
   `scamshield_llm_fallback_total` and `scamshield_llm_calls_total{outcome=…}`.
5. Free model providers may log prompts. Tell users (Settings has an opt-out) or use paid models
   with data-retention guarantees.

## Vercel

1. Set environment variables (Production + Preview separately).
2. Build command: `npm run build` (runs `prisma generate` via postinstall).
3. Run migrations before switching traffic: `DATABASE_URL=… npx prisma migrate deploy`
   (CI step or a one-off job; do not run `migrate dev` against production).
4. `vercel.json` schedules `/api/v1/cron/retention` daily; Vercel sends `Authorization: Bearer $CRON_SECRET`.
5. Function size: `next.config.ts` traces `ml/models/*.json` and tesseract.js worker files into the
   API functions. If OCR exceeds your plan's limits, set `OCR_PROVIDER=disabled`.
6. OCR downloads English language data (~10 MB) from the tesseract.js CDN on first use per cold
   instance. Self-host it and set `OCR_TESSERACT_LANG_PATH` to avoid the external fetch.

## Container / VM

```bash
npm ci
npx prisma migrate deploy
npm run build
NODE_ENV=production npm start   # behind a TLS-terminating reverse proxy
```
Set `TRUST_PROXY_HEADERS=true` only if the proxy overwrites `X-Forwarded-For`. Schedule
`curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/v1/cron/retention` daily.
`docker-compose.yml` provides Postgres + Redis for local development only.

## Security headers

Set by `next.config.ts` (all routes) and `middleware.ts` (pages): nonce-based CSP with
`strict-dynamic`, `frame-ancestors 'none'`, HSTS (production), `X-Content-Type-Options`,
`Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`, `COOP`. `upgrade-insecure-requests` is
added when `BETTER_AUTH_URL`/`APP_URL` is https. If you add third-party scripts (analytics),
extend `src/lib/security/csp.ts`.

## Observability

- Logs: one JSON object per line (`event`, `requestId`, `route`, latency, pipeline scores,
  `llmStatus`, …). Message content is never logged; sensitive keys are redacted.
- Metrics (`/api/v1/metrics`): request counts/latency, errors by code, analyses by level, LLM
  calls/latency/fallbacks, ML latency, URL/OCR failures, rate-limit events. Per-instance registry —
  on serverless, prefer pushing to an OTLP collector (not implemented).
- Alerts: example rules in `deploy/prometheus/alerts.yml`.
- Errors: `src/lib/observability/error-reporting.ts` exposes `registerErrorReporter`; install
  `@sentry/nextjs` and register it in `src/instrumentation.ts`.
- Audit trail: `analysis_event` table (analysis completed, LLM fallback/unavailable, rate limited,
  report created, OCR failed, request failed), pruned by the retention job.

## Release checklist

- [ ] `npm ci && npm run lint && npm run typecheck && npm test && npm run build`
- [ ] `npx playwright test` against a staging database
- [ ] `npx prisma migrate deploy` on the target database
- [ ] `/api/v1/health` returns `ok`/`degraded` with expected checks
- [ ] Startup logs show no unexpected `production_config_warning`
- [ ] OpenRouter models answer (check `llm` status in a test analysis)
