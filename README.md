# ScamShield

ScamShield checks suspicious **messages, links and screenshots** and tells you, in plain language,
whether something looks like a scam, **why**, and what to do next. Checks run **on your device**;
an AI second opinion is optional and off until you agree to it.

> **Preview — no official release yet.** The code is public for review and contributions. There
> are no published downloads yet; see [Download ScamShield](#download-scamshield).
> Detection is automated and **never 100% accurate**.

## Download ScamShield

There is **no published release yet**, so there is nothing to download from this page today. When a
release exists it will appear under [Releases](../../releases) with SHA-256 checksums, and on the
downloads page (`docs/site/`, published with GitHub Pages once releases exist).

## Platform status

| Platform | Status | Evidence |
|---|---|---|
| **macOS** (Apple silicon, macOS 14+) | Built (self-contained app + DMG) — **not notarized** | 147 Swift tests, 64-check UI self-test, launch/scan/recovery test of the DMG; Liquid Glass design verified on macOS 26+ (macOS 27.0.1), previous look on 14–25 (not tested on those versions) |
| **Android** | **Debug APK built**; not yet tested on a device or emulator; no signed release, not on Google Play | Same on-device engine as the server: 440/440 identical results on the test sets |
| **Chromium extension** | Works with the macOS app (local, unpacked); not in the Chrome Web Store | 14 unit tests, 8-check browser test |
| **Windows** | Planned — not built | — |
| **Linux desktop** | Planned — not built (the engine's tests pass on Linux) | — |
| **iPhone / iPad** | Planned — not built (needs Xcode and an Apple Developer account) | — |
| **Web app / API** (self-hosted) | Works locally | 742 TypeScript tests |

## How it works

- **Safety rules** (OTP/PIN/CVV requests, KYC threats, UPI refund tricks, job fees, investment
  promises, impersonation, remote-access requests, prompt-injection attempts, …; English, Hindi,
  Hinglish),
- **an on-device ML model** (TF-IDF + logistic regression, trained on the public UCI SMS Spam
  Collection plus hand-written synthetic examples — 3,771 training messages),
- **link analysis** (look-alike domains and character swaps, deceptive subdomains, punycode,
  shorteners, risky endings, downloads; an SSRF-safe link scanner),
- optionally an **AI second opinion** (OpenRouter, free models only, masked text only),

fused into one explainable score. A failed check is shown as **"Unable to assess"**, never as safe,
and the AI can raise a risk but never lower the on-device result.

Measured on test sets written for this project (not real-world traffic): 50/50 scams caught with
1/50 false alarm (blind set), 68/69 · 5/59 (held-out), 28/28 · 0/22 (realistic); look-alike links
100% precision / 90–96% recall at "high risk". See [`docs/ml/evaluation.md`](docs/ml/evaluation.md).

**Guides:** [macOS install](docs/guides/install-macos.md) · [Android](docs/guides/android.md) ·
[Privacy notice (draft)](docs/release/PRIVACY-NOTICE-DRAFT.md) · [Security](SECURITY.md) ·
[Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

## Architecture

```
User input ─► validation ─► preprocess ─► ┌ rules ────────┐
                                          │ ML classifier │
                                          │ URL analysis  ├─► risk fusion ─► level + score + category
                                          │ intel lookup  │        │            reasons + actions
                                          └ LLM (optional)┘        ▼
                                                           PostgreSQL (history, reports, intel)
```

Details: [`docs/architecture/production.md`](docs/architecture/production.md).
Pre-upgrade audit: [`docs/architecture/current-state.md`](docs/architecture/current-state.md).

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

All variables are documented in [`.env.example`](.env.example). Nothing is exposed to the browser.

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
[`docs/ml/evaluation.md`](docs/ml/evaluation.md) and are explicitly *not* real-world accuracy.
See [`ml/datasets/README.md`](ml/datasets/README.md) for the data a real model needs.

## Testing

```bash
npm run lint && npm run typecheck
npm test                          # unit + security + integration (integration needs TEST_DATABASE_URL)
npm run build && npx playwright install chromium && npm run test:e2e
```

Plan and coverage map: [`docs/testing/test-plan.md`](docs/testing/test-plan.md).

## API

Versioned under `/api/v1` with a consistent `{ success, data, meta }` / `{ success: false, error }`
envelope: `analyze/message`, `analyze/url`, `analyze/image`, `analyze/email`, `history`,
`reports`, `stats`, `settings`, `health`, `metrics`, `cron/retention`. The old `POST /api/scam` still
works (deprecated, same response shape). Reference: [`docs/api/endpoints.md`](docs/api/endpoints.md).

## Security model (summary)

- Identity comes only from the server-side session; all private data is scoped by user ID.
- Rate limits per endpoint and tier (anonymous / authenticated / premium-ready), Redis-backed.
- Strict Zod schemas (unknown fields rejected), byte limits enforced while streaming.
- Untrusted text is delimited for the LLM; LLM output is validated and cannot override rule/URL floors.
- URLs are analysed statically; optional fetching is SSRF-guarded (DNS + connect-time checks,
  redirect re-validation) — [`docs/security/ssrf.md`](docs/security/ssrf.md).
- Images: magic-byte sniffing, extension match, header-dimension limits; never stored.
- Email attachments: metadata only; never downloaded or executed.
- No raw message content stored; masked previews (opt-out), retention expiry, delete-all.
- Nonce CSP, HSTS, frame denial, nosniff, strict referrer & permissions policies; CORS allow-list (no wildcard).
- Structured logs with redaction; no stack traces to clients.

Threat model: [`docs/security/threat-model.md`](docs/security/threat-model.md).

## Deployment

See [`docs/deployment/production.md`](docs/deployment/production.md) (Vercel and container/VM,
migrations, cron, observability, release checklist).

## License

Apache License 2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). The ScamShield name and logo
are not covered by the licence; see [`TRADEMARKS.md`](TRADEMARKS.md).
