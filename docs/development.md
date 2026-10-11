# Development guide

Technical documentation for contributors and self-hosters (moved from the README). For using the
apps, see the [user guide](guides/user-guide.md).

## Architecture

```
User input ─► validation ─► preprocess ─► ┌ rules ────────┐
                                          │ ML classifier │
                                          │ URL analysis  ├─► risk fusion ─► level + score + category
                                          │ intel lookup  │        │            reasons + actions
                                          └ LLM (optional)┘        ▼
                                                           PostgreSQL (history, reports, intel)
```

Details: [`docs/architecture/production.md`](architecture/production.md).
Pre-upgrade audit: [`docs/architecture/current-state.md`](architecture/current-state.md).

| Layer | Tech |
|---|---|
| App / API | Next.js 15.5 (App Router, route handlers on the Node runtime), TypeScript (strict), Tailwind 4 |
| Auth | better-auth (Google OAuth; email/password only for local/E2E) |
| Data | PostgreSQL + Prisma 6 |
| Rate limiting | Redis (ioredis) with in-memory dev fallback |
| LLM | OpenRouter (OpenAI-compatible API), configurable model chain |
| ML | scikit-learn (training) → JSON → TypeScript inference |
| OCR | tesseract.js (pluggable provider) |
| Tests | Vitest (unit, security, integration), Playwright (E2E) |

## Quick start (local)

Prerequisites: Node 20.11+ (22 recommended), PostgreSQL 14+, Redis (optional locally), Python 3.10+ (only for ML training).

```bash
npm install                       # also runs prisma generate
cp .env.example .env              # then edit (see below)
docker compose up -d              # optional: local Postgres + Redis
npx prisma migrate deploy         # or: npm run db:migrate:dev
npm run dev                       # http://localhost:3000
```

Minimum `.env` for local development:

```env
DATABASE_URL=postgresql://scamshield:scamshield@localhost:5432/scamshield
BETTER_AUTH_SECRET=<openssl rand -base64 32>
BETTER_AUTH_URL=http://localhost:3000
GOOGLE_CLIENT_ID=...              # or AUTH_ENABLE_EMAIL_PASSWORD=true for local-only sign-in
GOOGLE_CLIENT_SECRET=...
REDIS_URL=redis://localhost:6379  # optional locally, required in production
```

All variables are documented in [`.env.example`](../.env.example). Nothing is exposed to the browser.

## OpenRouter setup

1. Create a key at https://openrouter.ai/keys → `OPENROUTER_API_KEY`.
2. Pick currently available models (free ones end in `:free`, see https://openrouter.ai/models?max_price=0),
   preferably from different vendors:
   ```env
   SCAM_PRIMARY_MODEL=<vendor-a>/<model>:free
   SCAM_FALLBACK_MODEL=<vendor-b>/<model>:free
   SCAM_FAST_MODEL=<vendor-c>/<small-model>:free
   ```
3. Restart. Swapping models never requires code changes. With no key or no models, ScamShield runs
   in deterministic mode and says so in every result.

The router retries transient errors with backoff, skips models that are rate-limited for long,
falls back primary → fallback → fast, opens a circuit breaker on repeatedly failing models,
validates every response with Zod, and gives up within `OPENROUTER_TOTAL_BUDGET_MS`.
Free-tier providers may log prompts; users can disable AI analysis in Settings.

## ML setup

```bash
python3 -m venv ml/.venv && ml/.venv/bin/pip install -r ml/requirements.txt
npm run ml:train              # trains on ml/datasets/seed → ml/models/scam-baseline.json
npm run ml:parity-fixture     # keeps the TypeScript/Python parity test in sync
npm run ml:evaluate -- --data path/to/holdout.csv
```

The committed model is a **seed model** (illustrative data; its fusion weight is halved and results
carry a warning). Seed cross-validation numbers are in
[`docs/ml/evaluation.md`](ml/evaluation.md) and are explicitly *not* real-world accuracy.
See [`ml/datasets/README.md`](../ml/datasets/README.md) for the data a real model needs.

## Testing

```bash
npm run lint && npm run typecheck
npm test                          # unit + security + integration (integration needs TEST_DATABASE_URL)
npm run build && npx playwright install chromium && npm run test:e2e
```

Plan and coverage map: [`docs/testing/test-plan.md`](testing/test-plan.md).

## API

Versioned under `/api/v1` with a consistent `{ success, data, meta }` / `{ success: false, error }`
envelope: `analyze/message`, `analyze/url`, `analyze/image`, `analyze/email`, `history`,
`reports`, `stats`, `settings`, `health`, `metrics`, `cron/retention`. The old `POST /api/scam` still
works (deprecated, same response shape). Reference: [`docs/api/endpoints.md`](api/endpoints.md).

## Security model (summary)

- Identity comes only from the server-side session; all private data is scoped by user ID.
- Rate limits per endpoint and tier (anonymous / authenticated / premium-ready), Redis-backed.
- Strict Zod schemas (unknown fields rejected), byte limits enforced while streaming.
- Untrusted text is delimited for the LLM; LLM output is validated and cannot override rule/URL floors.
- URLs are analysed statically; optional fetching is SSRF-guarded (DNS + connect-time checks,
  redirect re-validation) — [`docs/security/ssrf.md`](security/ssrf.md).
- Images: magic-byte sniffing, extension match, header-dimension limits; never stored.
- Email attachments: metadata only; never downloaded or executed.
- No raw message content stored; masked previews (opt-out), retention expiry, delete-all.
- Nonce CSP, HSTS, frame denial, nosniff, strict referrer & permissions policies; CORS allow-list (no wildcard).
- Structured logs with redaction; no stack traces to clients.

Threat model: [`docs/security/threat-model.md`](security/threat-model.md).

## Deployment

See [`docs/deployment/production.md`](deployment/production.md) (Vercel and container/VM,
migrations, cron, observability, release checklist).
