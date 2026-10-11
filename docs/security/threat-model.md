# ScamShield — Threat Model

Method: STRIDE-style review of assets, entry points and trust boundaries. Last reviewed 2026-10-07.

## Assets

1. User accounts and sessions (better-auth cookies).
2. Users' scan history and reports (may contain personal data in masked previews).
3. Secrets: `OPENROUTER_API_KEY`, `BETTER_AUTH_SECRET`, Google OAuth secret, DB/Redis credentials,
   `CRON_SECRET`, `METRICS_TOKEN`.
4. Integrity of verdicts (a wrong "SAFE" can cause financial loss).
5. Integrity of the scam-intelligence data (crowd reports).
6. Infrastructure (internal network reachable from the server, cloud metadata).
7. Budget (LLM spend, compute).

## Trust boundaries

Browser ↔ Next.js server · Server ↔ OpenRouter · Server ↔ arbitrary internet hosts (redirect
resolution, opt-in) · Server ↔ PostgreSQL/Redis · OCR worker ↔ uploaded image bytes.

## Threats and mitigations

| # | Threat | Mitigation (implemented) | Residual risk |
|---|---|---|---|
| T1 | **Prompt injection** in analysed content makes the LLM say "safe" | Nonce-delimited untrusted block + system rules; Zod-validated output; LLM weight 0.15; deterministic floors; injection rule discards a lower LLM verdict; LLM recommendations with URLs/phones dropped; LLM text shown only as "AI summary" | A novel injection the rules miss could still lower the LLM score — but never below the deterministic floor |
| T2 | **SSRF** via URL analysis | Static analysis by default (no fetch). Opt-in fetcher: http/https only, ports 80/443, no credentials, public-suffix hostnames, all A/AAAA records must be public, connect-time re-validation (DNS-rebinding safe), every redirect re-validated, ≤5 redirects, timeout, byte cap, no cookies. See `ssrf.md` | IPv6 transition ranges beyond those listed; new cloud metadata endpoints on public IPs |
| T3 | **Malicious uploads** (polyglots, decompression bombs, SVG/HTML) | Type sniffed from magic bytes; client MIME ignored; extension must match; dimensions parsed from header (≤10 000 px/side, ≤40 MP) before decoding; 5 MB cap enforced while streaming; image never stored or served back | Bugs in the WASM OCR decoder (sandboxed in WASM, bounded by timeout) |
| T4 | **Malicious email attachments** | Only metadata (name, declared type, size) is accepted; schema rejects unknown fields such as file content | — |
| T5 | **IDOR** on history/reports | All queries scoped by session user ID; foreign IDs return 404; strict schemas reject client-supplied `userId` | — |
| T6 | **CSRF** on cookie-authenticated writes | Cross-origin `Origin` (or `Sec-Fetch-Site: cross-site`) rejected for POST/PUT/DELETE; better-auth validates trusted origins; cookies `SameSite=Lax`, `Secure` in prod | — |
| T7 | **XSS** | React escaping; no `dangerouslySetInnerHTML`; nonce-based CSP with `strict-dynamic`; suspicious URLs rendered as text | `style-src 'unsafe-inline'` (needed by Next/framer-motion) |
| T8 | **Clickjacking** | `frame-ancestors 'none'`, `X-Frame-Options: DENY` | — |
| T9 | **Denial of wallet / abuse** | Per-scope, per-tier rate limits (Redis), anonymous limits low and switchable off (`ALLOW_ANONYMOUS_ANALYSIS`), input caps (10k chars, 64 KB bodies), LLM input truncated to 6k chars, total LLM time budget, bounded retries | IP-based anonymous limits can be evaded with many IPs; disable anonymous analysis if abused |
| T10 | **Intel poisoning** (fake reports to whitelist or blacklist content) | Reports cannot lower scores; one report per user per content; ≥2 distinct reporters before use; confidence capped; REJECTED status ignored | Sybil accounts; no reviewer UI yet |
| T11 | **Secret leakage** | Secrets only in server env; no `NEXT_PUBLIC_` secrets; log redaction by key and pattern; health endpoint exposes no connection info; no stack traces in responses | — |
| T12 | **Sensitive data retention** | No raw content stored; masked previews (opt-out); retention expiry + cron; delete-all endpoint; anonymous scans not stored | Masking is heuristic (names/addresses are not masked) |
| T13 | **Third-party LLM data exposure** | User setting to disable LLM; OpenRouter free models may log prompts — documented | Users who keep LLM enabled send scanned text to OpenRouter and the upstream model provider |
| T14 | **Open redirect after login** | `next` parameter restricted to same-site relative paths | — |
| T15 | **Rate-limit bypass via spoofed X-Forwarded-For** | `TRUST_PROXY_HEADERS` must be `false` when not behind a trusted proxy | Misconfiguration |
| T16 | **Vulnerable dependencies** | Upgraded Next.js (15.2.3 → 15.5.27), better-auth, removed axios/openai/@auth/prisma-adapter | Remaining advisories: PostCSS bundled in Next (build-time), deepmerge-ts in Prisma CLI and braces in eslint-config-next (dev-time); fixing requires major upgrades (Next 16, Prisma 7) |

## Out of scope / not yet addressed

- WAF / bot management (recommend Vercel Firewall or Cloudflare in front).
- Account security features (MFA, session listing) beyond better-auth defaults.
- Formal privacy review (DPDP Act 2023 / GDPR) — the retention and deletion controls are a
  starting point, not a compliance claim.
