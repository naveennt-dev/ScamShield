# Release audit — 2026-10-11

**Outcome: NOT READY for public release.** No known critical/high security issue remains open, but
public distribution is blocked by packaging/legal items (§9). For personal use on this Mac the
current build is functional and was re-verified end to end.

Backup taken before changes: `~/ScamShield-backups/scam-shield-main-20261011-183330.tgz` (0600; no
`.env` files). No Git repository exists for ScamShield, so there is no Git history to audit.

## 1. Inspected

Next.js web app + API (19 route handlers, middleware, auth), detection engine, link scanner, SSRF
fetcher/proxy, isolated-browser worker, Python ML service, macOS app (5 Swift targets), Chromium
extension, Prisma schema/migrations, scripts (install/uninstall/local-stack/model-registry), build
outputs (`.next`, app bundles), local logs, docs, dependency manifests and lockfiles.

## 2. Secrets

| Location | Type | Status |
|---|---|---|
| `.env` (ignored) | OpenRouter key, auth secret, DB/Redis URLs | Local only. Exact-value scan of 18,395 project files (incl. `.next`, app bundles, logs, docs) and of the 437 files inside the release artefacts: **not found anywhere else**. Never printed. |
| `db/.env` (ignored) | Belongs to a **separate project** nested in `db/` (own Git repo, no commits, no remote): 2 DB URLs, 2 Redis URLs, `SECURITY_API_KEY` set; AWS/Anthropic/Gemini/Telegram slots empty | Local only; not referenced by ScamShield; now excluded from releases. Recommend moving `db/` out of this folder (needs your approval). |
| `~/Library/Application Support/ScamShield/keys/` | Model-signing private key | Outside the project, 0600. |
| Keychain | "ScamShield Local Signing" code-signing identity | Outside the project. |
| `tests/integration/db-down.test.ts`, `.next` cache | pattern hits | False positives (fake unreachable DB URL; library code mentioning a PEM header). |

No secret was committed or published (no Git history; no public remote). No rotation needed.

## 3. Findings and fixes

| ID | Severity | Finding | Status |
|---|---|---|---|
| A1 | High | **DNS rebinding**: the local service accepted any `Host`, so a malicious website rebinding its name to 127.0.0.1 could drive scans, contributions and isolated-browser inspections from the user's machine (verified live: 200). | **Fixed** — Host allow-list in middleware (`src/lib/security/hosts.ts`); verified live: foreign hosts incl. `127.0.0.1.nip.io` → 421; 14 tests. |
| A2 | High | **Release packaging**: `db/` (another project with its own `.venv`, caches, Git) and the 379 MB development app build were not excluded; the model-signing **public** key was excluded by `*.pem` (updates could not be verified). | **Fixed** — `.gitignore`; release contents verified (411 files). |
| A3 | Medium | **Prompt-injection path**: AI hints sat outside the untrusted-content delimiters and could quote page titles / file names. (Impact bounded: AI can only raise, output schema-validated.) | **Fixed** — hints one-line, bounded, delimiter-neutralised; page-derived text cleaned; test added. |
| A4 | Medium | Isolated-browser inspection is **not VM-isolated** (no OS network wall around Chromium on macOS; runs as the user). | **Mitigated** — now **off by default** (service needs `SCAMSHIELD_DYNAMIC_INSPECTION=1`; app setting off). Residual risk documented in `docs/design/link-protection.md` §4. |
| A5 | Medium | Inspections shared the ordinary scan rate limit. | **Fixed** — own `inspect` limit (anonymous 2/min, local 6/min); route test. |
| A6 | Medium | 10 npm advisories (9 high, 1 moderate): `postcss` (via Next build), `braces`/`micromatch`/`fast-glob` (ESLint plugin), `deepmerge-ts` (Prisma CLI). All build/dev-time; none reachable from the running app. Fixes require major upgrades (Next 16, Prisma major). | **Accepted, open** — upgrade in a tested branch before public deployment. |
| A7 | Medium | Local `.env` has `AUTH_ENABLE_EMAIL_PASSWORD=true` (no email verification). Template default is `false`. | **Open** (your config; not changed) — must be `false` for any public deployment. |
| A8 | Low | 3 unused dependencies (`framer-motion`, `react-virtuoso`, `server-only` — no imports, no dependents). | **Removed**; build/tests pass. |
| A9 | Low | Stale test artefacts in `.scamshield-run/` (old scan/offline outputs with test message text). | **Removed** (service logs/PIDs/app backup kept). |
| A10 | Low | `style-src 'unsafe-inline'` in CSP; health endpoint reports component status and model build id. | Accepted (needed by UI / app health check). |
| A11 | Low | No Python vulnerability scanner installed (`pip-audit`). | Open — not installed without your approval. |

Verified as already correct (no change): API input validation (strict schemas, 413/415/400), CSRF/
origin checks (cross-site POST → 403), auth on history/reports/settings with per-user scoping (no
IDOR), constant-time bearer checks, cron/metrics disabled without tokens, generic error bodies (no
stack traces/paths), nonce CSP, secure cookies, no `NEXT_PUBLIC_*` secrets, no logging of message
text/URLs/credentials (live service log scanned: none), Mac logs contain only IDs/counts/statuses,
no screenshots written to disk, all Mac network calls go to the loopback service, SSRF policy (61 +
18 + link-scan tests), isolated browser writes nothing outside its profile (verified on a live run).

## 4. Tests actually run (this audit)

| Suite | Result |
|---|---|
| TypeScript typecheck / ESLint (src, scripts, tests, extension) | 0 errors / clean |
| Vitest (unit, integration with real Postgres test DB, security) | **717 passed** (36 files) |
| Python ML tests | 39 passed |
| Swift tests + production and development app builds | 134 passed, both builds OK |
| macOS developer self-test (real app vs live services) | 62/62 |
| Extension end-to-end (Playwright Chromium vs live service) | 8/8 |
| Live probes (malformed input, CSRF, auth, metrics/cron, rebinding) | as listed in §3 |
| Detection sets (synthetic) | blind-v3 50/50 & 1/50 FP · heldout-v2 68/69 & 5/59 · realistic-v1 28/28 & 0/22 |
| Prisma migration status | up to date |
| Exact-value secret scans (project; artefacts) | none found |

Not run: physical full-screen/region scans by a person in this audit (covered by the self-test and
earlier sessions), uninstall on this machine (destructive; covered by sandboxed tests in Phase 6),
URLhaus/PhishTank live (no keys), extension in your own Chrome/Edge profile, other Macs.

## 5. Platform status

| Platform | Status |
|---|---|
| macOS app (Apple Silicon, macOS 27) | Built, installed, self-tested on this Mac only. **Signed with a self-signed local identity — not Developer ID, not notarized.** |
| Local services (Next.js, Python ML, Postgres, Redis) | Running and tested on this Mac. |
| Website (public deployment) | Builds; not deployed or tested on a public host. |
| Chromium extension | Tested in Playwright's Chromium; not in a real user profile; not in any store. |
| Android / iOS / Windows / Linux | Not built. |

## 6. Third-party data sharing (only when the user chooses online / AI mode)

OpenRouter (AI second opinion): masked text, or for links only the website address + findings;
free-tier models only. The scanned website itself (contacted by the inspector, without user
cookies). URLhaus / PhishTank: only if keys are configured (not configured); receive
`scheme://host/path`. Opt-in contributions go to the configured ScamShield service (local by
default). Nothing is uploaded for training automatically. Licences and notices:
`docs/release/THIRD_PARTY_NOTICES.md` (LGPL libvips, CC-BY caniuse-lite and UCI data).

## 7. Artefacts (local only, not distributed)

`~/ScamShield-release-staging/` — `ScamShield-macOS.zip`, `ScamShield-LinkGuard-extension.zip`,
`ScamShield-source.tar.gz`, `SHA256SUMS`. SBOM: `docs/release/sbom-npm-runtime.cdx.json`; Python
lock: `docs/release/python-ml-requirements.lock.txt`. (Artefacts were built before the final
"inspection off by default" change; rebuild before any distribution.)

## 8. Remaining risks

No detector is 100% accurate; detection figures are on synthetic sets. Remote AI and the scanned
websites see what §6 lists. The isolated browser, if a user opts in, can be compromised by a
Chromium exploit. The extension can't block navigations synchronously and doesn't cover sub-frames,
private windows or start-up. Build-time npm advisories (A6).

## 9. Release blockers (public distribution)

1. **No project licence** (`LICENSE`) — your decision.
2. **No user-facing privacy policy / terms** — needed before public users.
3. **macOS app not Developer ID-signed or notarized** — other Macs' Gatekeeper will block it (needs an Apple Developer account).
4. **Installation needs Terminal and local developer tooling** (Node, Python, PostgreSQL, Redis, `scripts/install.sh`) — not suitable for ordinary users; needs a packaged installer or a hosted service.
5. **A6** dependency upgrades (Next/Prisma majors) tested before any public web deployment; **A7** must be `false` in production.
6. Move the unrelated `db/` project out of the ScamShield folder (approval needed).

## 10. Reproduce

```
npx tsc --noEmit && npx eslint src scripts tests extension && npx vitest run
ml/.venv/bin/python -m pytest ml/tests -q
macos/scripts/test.sh                       # Swift tests + both app builds
EXPECT_BACKEND=1 REBUILD=1 macos/scripts/smoke-test.sh
npx tsx scripts/e2e-extension.ts            # needs the local service running
npm audit ; npx prisma migrate status
npx tsx --env-file=.env scripts/eval-realistic.ts tests/fixtures/eval/blind-v3.jsonl
```
