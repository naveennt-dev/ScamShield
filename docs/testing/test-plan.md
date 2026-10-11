# Test Plan

## Suites

| Suite | Command | Needs | Location |
|---|---|---|---|
| Unit | `npm run test:unit` | nothing | `tests/unit/` |
| Security | `npm run test:unit` (same run) | nothing | `tests/security/` |
| Integration (API + DB) | `npm run test:integration` | `TEST_DATABASE_URL` (migrations auto-applied); skipped otherwise | `tests/integration/` |
| E2E | `npm run build && npm run test:e2e` | `TEST_DATABASE_URL`, `npx playwright install chromium` | `tests/e2e/` |
| ML parity | part of unit (`tests/unit/ml.test.ts`) | committed model + fixture | — |
| ML training checks | `npm run ml:train` | Python venv | export-fidelity check inside `train.py` |

`npm test` runs unit + security + integration. Tests never call OpenRouter (the key is removed in
`tests/setup.ts`), never use Redis (in-memory limiter), and never touch the development database.

## Coverage map

**Unit**
- Rules: each scam family; negation ("never share your OTP"); legitimate OTP/KYC messages score 0;
  "pin code" ≠ PIN; in-person delivery OTP exception vs reschedule scam; obfuscation (zero-width,
  Cyrillic homoglyphs); evidence masking.
- URL extraction/normalisation: explicit/bare/defanged URLs, punctuation, emails/file names
  excluded, bare IPs, 20-URL cap.
- URL analysis: official domains, brand impersonation, typosquat, IDN homograph, IP/obfuscated IP,
  internal targets, shorteners, userinfo trick, executables, `javascript:`, reputation input.
- Risk fusion: bounds, renormalisation, deterministic floor vs LLM "safe", critical floor,
  injection guard, corroboration boost, seed down-weighting, LLM-alone cap, category choice.
- Thresholds.
- LLM schema validation: valid/fenced/`<think>` output, coercion, out-of-range and enum
  rejection, malformed JSON, URL/phone recommendation filtering, bounds.
- Prompt construction: nonce delimiters, delimiter spoofing neutralised.
- OpenRouter client: status mapping (401/402/404/400/429/5xx), 200-with-error, empty content,
  timeout, missing key, Retry-After parsing.
- Model router: primary success, retry+backoff then fallback, long Retry-After skip, 404 fallback,
  malformed JSON retry/fallback, JSON-mode downgrade, auth abort, bounded attempts, total budget,
  circuit breaker, chain configuration.
- ML: TS/Python parity (tokens + probabilities to 1e-9), bounds, seed flag, malformed model files.
- Fingerprints/SimHash, redaction, image validation (real PNG/JPEG/WebP, spoofed SVG/HTML/EXE,
  extension mismatch, decompression bomb, tiny), email metadata analysis, rate limiter (windows,
  tiers, isolation, anonymous reports, Redis-failure fallback).

**Security** (`tests/security/`)
- SSRF: blocked ranges, hostname policy, protocol/port/credentials, DNS failure, mixed records,
  redirects to internal targets, loops, connect-time rebinding against a real local server.
- Mandatory scenarios (pipeline): see below.

**Integration** (`tests/integration/api.test.ts`, real Postgres, route handlers called directly,
session mocked)
- Message analysis anonymous vs persisted; masked storage (OTP never stored).
- Malformed JSON, wrong content type, empty/missing/non-string message, client-supplied `userId`,
  over-length, over-size body; no stack traces.
- Cross-site POST rejected; same-origin accepted. Anonymous rate limit → 429 + Retry-After.
  `ALLOW_ANONYMOUS_ANALYSIS=false`.
- History: 401 unauthenticated; user B cannot read/delete/list user A's analysis; pagination,
  filtering, invalid limit.
- URL endpoint (internal URL, invalid URL, `javascript:`), email endpoint (spoofed brand, `.pdf.exe`,
  attachment content rejected), image endpoint (OCR disabled 503, valid PNG, spoofed SVG, extension
  mismatch, wrong content type, missing field, no text 422).
- Reports: auth required, duplicate 409, distinct reporters aggregate, near-duplicate variant
  counted, pattern feeds the detector only after 2 reporters, analysisId ownership, domain
  reputation after 2 reporters.
- Settings (preview off, LLM off, retention), stats scoping, delete-all scoping.
- Health; metrics/cron token enforcement and
  retention deletion.

**E2E** (Playwright, production build, email/password test auth)
- Redirect to sign-in when signed out.
- Sign up → scan message → result (level, reasons, actions, link shown as text) → report →
  history list/detail → reports page → dashboard counts; zero CSP violations.
- Legitimate OTP message shows SAFE. URL scan flags metadata IP. Screenshot scan with real OCR.
  Email scan attachment warning. Sign-out.
- Mobile (Pixel 7): navigation menu; no horizontal scroll on every page after real content exists.

## Mandatory scenarios (spec §29)

| # | Scenario | Test |
|---|---|---|
| 1 | Legitimate bank message | `pipeline-scenarios` #1, E2E "legitimate bank OTP" |
| 2 | Fake bank KYC | `pipeline-scenarios` #2, E2E main flow |
| 3 | Fake UPI refund | `pipeline-scenarios` #3 |
| 4 | Fake job offer | `pipeline-scenarios` #4 |
| 5 | Lottery scam | `pipeline-scenarios` #5 |
| 6 | Investment scam | `pipeline-scenarios` #6 |
| 7 | Delivery scam | `pipeline-scenarios` #7 |
| 8 | Suspicious URL | `pipeline-scenarios` #8, `url.test.ts` |
| 9 | URL containing localhost | `pipeline-scenarios` #9, `ssrf.test.ts` |
| 10 | URL resolving to private IP | `ssrf.test.ts` (resolver + rebinding), `pipeline-scenarios` #10 |
| 11 | Prompt injection | `pipeline-scenarios` #11, `fusion.test.ts`, `ai.test.ts` |
| 12 | Extremely long message | integration "over max length/body size" |
| 13 | Empty message | integration "empty message" |
| 14 | Malformed request | integration "malformed JSON", "non-string", "wrong content type" |
| 15 | OpenRouter unavailable | `pipeline-scenarios` #15 |
| 16 | Primary model unavailable | `pipeline-scenarios` #16, `ai.test.ts` router tests |
| 17 | Invalid model JSON | `pipeline-scenarios` #17, `ai.test.ts` |
| 18 | Rate limit exceeded | integration "rate-limits anonymous callers", `rate-limit.test.ts` |

## Not covered (known gaps)

- Google OAuth flow (needs real Google credentials; E2E uses email/password test auth).
- Redis store is tested only when `TEST_REDIS_URL` is set (`tests/integration/redis.test.ts`); API tests use the memory store.
- Real OpenRouter calls (verified manually against a local OpenAI-compatible stub; no live key).
- Load/performance testing.
- System-level detection accuracy on real data (no labelled dataset).
