# Phase 6 Completion Report — Personal Release, Hardening & Acceptance Testing

Dates: 2026-10-10 / 11. Hardware: Apple M4, 16 GB RAM, macOS 27.0.1. The OpenRouter key and `.env`
were not modified, printed or read into any report. No live OpenRouter calls were made in this
phase.

**Status: COMPLETE**, with the disclosures in §9.

## 1. Summary of actual changes

| Area | Change | Why (evidence) |
|---|---|---|
| **Durable database** | `scripts/local-stack.sh` now creates, starts and stops PostgreSQL in `~/Library/Application Support/ScamShield/server/postgres` (127.0.0.1, migrations on start) and Redis (127.0.0.1, nothing persisted). | The backend's database was living in this assistant session's **temporary scratch folder** (`/private/tmp/…`), a cluster created during development. It would have vanished, and the stack never started it. All 116 rows were copied to the durable cluster (counts verified). |
| **Scanning without the database** | Health reports `degraded` (not `down`) when PostgreSQL is unavailable. | Measured: with PostgreSQL stopped, analysis still returned HTTP 200 (critical) in 19 ms, but health said `down`, so the Mac app refused **every** scan. Regression test added. |
| **Local rate-limit tier** | Loopback clients of the personal stack get 60/min and 2,000/day instead of the anonymous 5/min and **30/day**. Opt-in (`LOCAL_CLIENT_RATE_TIER`, set by the stack script); requires a loopback client **and** a loopback Host header. | The anonymous daily cap would have made the Mac app stop working after 30 scans in a day. It also broke a self-test run here. |
| **Single instance** | A second launch hands over (the running app opens its menu) and quits. | Verified: two launches leave one process. |
| **Install / run / uninstall** | `scripts/install.sh`, `scripts/scamshield.sh`, `scripts/uninstall.sh`; stale-PID and port-conflict detection in the stack script. | — |
| **Stable signing (optional)** | `build-app.sh` signs with "ScamShield Local Signing" if present (`macos/scripts/create-signing-identity.sh`), otherwise ad-hoc. | Ad-hoc builds lose the Screen Recording grant on every rebuild. With the certificate, the grant survived a rebuild (§7). |
| **Clearer failures** | A timeout now says "took too long to respond", not "service isn't running". The "cloud AI enabled" message no longer refers to a phase. | A slow service was misreported as not running. |
| **Test hygiene** | Swift and self-test runs remove the UUID-named preference files they create (170 had accumulated in `~/Library/Preferences`). | Found during the audit. |
| **Measurements** | Startup log line (`launch ready in N ms`), `scripts/bench-local.ts`, a self-test soak and UI-responsiveness checks, and a history-capacity test. | §5 |

## 2. Build and installation commands

```bash
scripts/install.sh                 # check prerequisites → build API + app → install ~/Applications/ScamShield.app
scripts/scamshield.sh start        # database, Redis, ML service, API, then opens the app
scripts/scamshield.sh stop | restart | status
scripts/uninstall.sh [--reset-permissions] [--delete-user-data]
macos/scripts/create-signing-identity.sh   # optional: stable signing (keeps the Screen Recording grant)
```

The full guide is `docs/guides/installation.md`.

## 3. Files changed

**New:**
- `scripts/install.sh`, `scripts/scamshield.sh`, `scripts/uninstall.sh`
- `scripts/bench-local.ts`
- `macos/scripts/create-signing-identity.sh`
- `tests/integration/db-down.test.ts`, `tests/security/local-tier.test.ts`
- `macos/ScamShield/Tests/ScamShieldCoreTests/ReliabilityTests.swift`
- `docs/guides/installation.md`, this file

**Changed:**
- `scripts/local-stack.sh` (PostgreSQL/Redis management, stale PIDs, port conflicts, `restart`, local tier)
- `macos/scripts/build-app.sh` (optional stable identity)
- `macos/scripts/test.sh` (preference-file cleanup, exit code preserved)
- `macos/scripts/smoke-test.sh` (wait up to 240 s; cleanup)
- `src/app/api/v1/health/route.ts`
- `src/lib/config/env.ts` (`LOCAL_CLIENT_RATE_TIER`)
- `src/lib/api/{handler,request-context}.ts`
- `src/lib/rate-limit/{index,types}.ts`
- `macos/ScamShield/Sources/ScamShield/ScamShieldApp.swift` (single instance, startup timing)
- `ScannerCoordinator.swift` (timeout mapping)
- `ScannerState.swift` (message wording)
- `SelfTest.swift` (soak check; real-click immunity for the drag checks)
- `Tests/ScamShieldCoreTests/ScannerTests.swift`: one expectation updated to the new timeout
  mapping, equally exact (§9)
- `docs/guides/manual-verification.md`

## 4. Test results (actual totals)

**1. Automated unit / integration** (no network):

| Suite | Result |
|---|---|
| TypeScript (`npx vitest run`, 22 files) | **412 passed** (407 + 5 new local-tier tests; db-down test included) |
| ESLint / `tsc --noEmit` / `next build` | 0 / 0 / compiled |
| Python ML (`npm run ml:test`) | **39 passed** (1 third-party deprecation warning) |
| Swift (`macos/scripts/test.sh`) | **106 passed** (98 core + 8 UI; 5 new reliability tests); 0 warnings |
| Migration check (`npm run db:verify-migrations`, throw-away DB) | **PASSED** (upgrade, rollback and re-apply keep rows) |
| Shell scripts | `bash -n` clean |

**2. Mocked provider tests:** the 35 Phase 4 OpenRouter tests (failure modes, prompt injection,
never-lowers, free-only guard) are part of the 412.

**3. Live provider tests:** **none run** in Phase 6, by design (quota). Last live verification:
Phase 4 (`phase-4-completion.md`).

**4. Physical macOS tests** (real app, real stack, this Mac):

| Test | Result |
|---|---|
| Install from source → `~/Applications` | ✅ 46 s; bundle verified free of `.env` and keys |
| Upgrade over an existing install | ✅ `history.json` and `reports.json` byte-identical (SHA-256), database rows (136) and settings unchanged; previous app kept as a backup |
| Second launch | ✅ one process; "handing over" logged |
| Stack: stale PID after a simulated crash; unrelated server on port 3000 | ✅ stale file removed; start refused, naming the conflicting program (Python, pid) |
| Stop | ✅ 0.2 s, all ports freed |
| Uninstall (sandbox): app-only, wrong confirmation, typed DELETE, unrelated app | ✅ app-only keeps data; wrong confirmation keeps data; DELETE removes it; unrelated app untouched (see the incident in §9) |
| Stable signing: grant once → rebuild + reinstall → real capture without re-granting | ✅ PASS (region 1520 × 720 px, full display 3024 × 1964 px) |
| App self-test, online, after the rebuild | ✅ 61 / 61, 0 skipped (an earlier run in the same session reported one failure whose details were overwritten before I read them; see §9) |

**5. Physical Wi-Fi-off test** (2026-10-11, 01:16:52–01:18:55): ✅ **OFFLINE CHECK PASSED**.
- internet unreachable; stack healthy, LLM disabled; KYC scam → critical 93 via the local ML;
- **app self-test 61 / 61, 0 skipped**, including real capture, history, the 25-scan soak and the
  real-mouse-event drag checks;
- **0 non-loopback sockets in 242 samples**, 0 OpenRouter events; Wi-Fi restored automatically.

Eleven real clicks happened during the run (recorded); none affected a check.

## 5. Measurements (Apple M4 / 16 GB / macOS 27.0.1)

| What | Measured |
|---|---|
| App startup (process start → menu bar ready, from the app's log) | **733 ms** |
| `scripts/scamshield.sh start` (services already built, database start + migrations, app open) | **4.6 s** |
| `scripts/local-stack.sh stop` | **0.2 s** |
| Local pipeline, in-process, 200 scans (`scripts/bench-local.ts`, ML via the service) | **p50 6.1 ms · p95 8.4 ms** · max 108 ms (first-hit outlier) |
| Local API over HTTP (5 calls) | 13 / 19 / 54 ms (min / median / max) |
| Full Mac scan in the self-test (capture → OCR → API → result) | ≈ 2 s; mostly the UI's deliberate stage pacing, analysis itself is milliseconds |
| UI responsiveness during a scan (largest main-thread gap) | 56 ms (local); 35 ms during an 11 s remote scan (Phase 4) |
| Remote-assisted scan | 3.6–15.8 s (Phase 4 live measurements; not re-run) — the local result never waits on it unless remote is chosen |
| Idle, 60 s / 7 samples (CPU avg · memory) | app 0.0% · 120 MB; API 0.0% · 299 MB; ML 0.1% · 193 MB; PostgreSQL 0.0% · 82 MB; Redis 0.5% · 3 MB |
| 25 repeated scans (self-test soak) | 25 / 25 results, 1 window, memory +1.3 MB (offline run); earlier runs −7.2 and −12.2 MB |
| History at capacity (500 entries) | record + save 5 ms; load 5 ms; file 253 KB |
| Recovery after 20 failed scans | clear error each time, exactly one request per scan, next scan succeeds (Swift test) |

## 6. Security and privacy audit findings

| Check | Result |
|---|---|
| Listening interfaces | API, ML, PostgreSQL and Redis **127.0.0.1 only** (`lsof`) |
| Local-only makes no external requests | 0 non-loopback sockets (offline run); network-call spies in tests; 0 OpenRouter events |
| Screenshots never sent / stored | Images never leave the capture/OCR scope; history holds no text or image (self-test) |
| Remote AI requires configuration **and** per-scan consent; free-only, no paid fallback | Unchanged; covered by the mocked suite |
| Secrets in logs / reports / bundle | Searched every `.scamshield-run/*.log`, `postgres.log`, the app's unified log (3 h) and the installed bundle for the key, test-message text and URL tokens: **none found**. The installer also refuses a bundle containing `.env` or a key |
| URL query tokens redacted in logs | Unchanged (Phase 5), tested |
| Links never opened automatically; SSRF protections | Unchanged, tested |
| Data permissions | `~/Library/Application Support/ScamShield` and `server/` 0700; `history.json`, `reports.json` 0600 |
| Database authentication | Your `DATABASE_URL` has **no password**, so the durable cluster uses trust authentication on 127.0.0.1. Any process on this Mac can connect. Recommendation: add a password to `DATABASE_URL` (I did not change `.env`) |
| Migrations / access controls | Unchanged; the migration check passes |

## 7. Screen Recording after the final build

The final build is signed with the stable "ScamShield Local Signing" certificate. You granted the
permission once on 2026-10-11, and it **survived a rebuild and reinstall** (verified by real
capture). **No re-grant is needed** for future installs unless you delete the certificate, or
build on a Mac without it (then ad-hoc signing is used and re-granting is required after each
rebuild).

## 8. Steps you must perform manually

None are required for the current install. Optional:
1. **Use it:** `scripts/scamshield.sh start` after a reboot (services aren't started at login by
   design).
2. **Tighten the database** (recommended): add a password to `DATABASE_URL`. An existing cluster
   then also needs `ALTER USER … PASSWORD …`; or stop the stack, move
   `~/Library/Application Support/ScamShield/server/postgres` aside, and start again, which
   creates a fresh cluster but loses the 136 event rows.
3. **Re-check History settings** in the History window (see §9).

## 9. Remaining issues, unverified behaviour and disclosures

- **Incident: your app preferences were reset.** While testing the uninstaller in a sandbox with an
  overridden `HOME`, `defaults delete dev.scamshield.mac` reached your **real** preferences.
  macOS preferences don't follow `HOME`.
  - **Lost:** the shortcut (back to ⇧⌘S), History settings (history on, excerpt off, 90 days),
    the menu-bar icon position, and the duplicate-detection salt (regenerated).
  - **Not affected:** the analysis mode stays "On this Mac only"; history, reports, database and
    `.env` were not touched.
  - **Fix:** the uninstaller now uses `defaults` only for your real home folder; a re-run of the
    sandbox test proved a marker in your real preferences survives. There was no backup to
    restore from.
- **Unexplained self-test failure:** one run after the grant reported a failure whose details were
  overwritten by the next run before I read them. Real clicks on the menu-bar icon were recorded
  during that run. The next two full runs (online and offline) passed 61 / 61.
- **Test expectation changed:** `ScannerTests` "failure mapping": timeout now expects
  `.analysisFailed("…took too long to respond…")` instead of `.analysisServiceUnavailable`. That's a
  deliberate behaviour change (a slow service isn't "not running"), asserted just as exactly.
- **Rate limit:** with the local tier, the Mac app's cap is 60 scans/min and 2,000/day.
  Starting the API without `scripts/local-stack.sh` (e.g. `npx next start`) brings back the
  anonymous 5/min and 30/day.
- **Services don't start at login** (no LaunchAgent added, to keep infrastructure minimal). Run
  `scripts/scamshield.sh start`.
- **Not notarized / no Developer ID** (paid Apple membership). The app is for this Mac only.
- **The installer's backup was deleted** by an uninstall test run, leaving no rollback copy at the
  time. The next install created a fresh one.
- **Multi-display:** display changes are covered by placement logic and unit tests. A physical
  multi-monitor test wasn't possible (one display).

---

# Corrective fix (2026-10-11): real detection, real scan results, real History

You reported that real scans looked wrong. Your own History confirmed it: all 6 earlier scans were
"safe" (3–25), including ones with real indicators. Each symptom was reproduced and traced
separately. They did **not** share one cause.

## 1. Bugs and confirmed root causes

| Reported symptom | Root cause (evidence) | Fix |
|---|---|---|
| "Clicking Suspicious always shows Suspicious; Critical always Critical" | **Sample-data previews in normal use.** `Info.plist` shipped `ScamShieldDebug = true`, so every development build showed a "PREVIEW (SAMPLE DATA)" menu whose Safe, Suspicious and Critical items display canned results without looking at the screen. A Settings toggle could also turn it on. | Debug off by default; the toggle was removed from Settings; a saved preference can't enable it (only `SCAMSHIELD_DEBUG=1`); `AppState.preview` refuses outside a developer session. |
| Full-screen scans return safe | **OCR assembled the whole screen row by row**, interleaving a chat message with desktop labels and other windows ("…ka bill **veenTan…icate.pdf**"). The scam text was then diluted by unrelated screen text (the ML scored the blob, not the message). Measured with real captures: Hinglish scam **safe 10** (region: high 72), UPI scam suspicious 48 (region: high 81). | **Mac:** layout-aware OCR assembly (`TextAssembler`) groups observations into spatial blocks. **Backend:** `source: "screen"` analysis (`src/lib/detection/screen.ts`) runs every block and the whole text through the real pipeline and reports the riskiest, with its own evidence. A block may win on ML alone only if it is message-length **and** ML ≥ 70; this prevents a short UI fragment from becoming a false alarm (measured: a terminal tip line scored ML 51). |
| Region / any scans miss phrases | **OCR line wraps reached the rules as sentence breaks.** Proximity rules stop at newlines, so "share the" / "OTP" on two lines didn't match. Measured: wrapping dropped `kyc.urgent_update`, `upi.pin_to_receive` and `cred.card_details`, and phishing went from 83 to 68. | Soft wraps are joined inside each block. Every fixture now scores identically wrapped and unwrapped (tested). |
| Fake messages shown green "no suspicious found" (about half, in your physical test after the first fixes) | **Real rule gaps** plus a weak ML model. The scan-ID diagnostics of your 10 region scans showed the misses had **no rule match and ML ≈ 50** (a coin flip, fused to 29, just under 30). A realistic set of 28 common Indian scam types found 3 missed families (emergency-money requests, crypto "doubling", Hinglish/Hindi utility disconnection) and 1 false alarm (news about scams). | New rules, each with a genuine look-alike guard: `utility.disconnection_threat` (EN/Hinglish/Hindi; not maintenance notices), `pay.emergency_money_request` (not ordinary "send 500 for dinner"), `invest.crypto_doubling`, `gov.fake_fine` (not `.gov.in` links), `delivery.customs_threat`; an awareness guard (news text that never addresses "you") for government-threat rules. |
| A safe card doesn't explain itself; uncertain results look like a clean bill | The safe card showed no reasons or score; a score of 29 with a 50/50 ML still said "No suspicious content detected". | The safe card shows its score and the engine's real findings. "No suspicious content detected" appears only when the check is clean (score < 15, no indicators); otherwise "Low risk — a few weak signs" plus advice. An unavailable ML model is disclosed ("limited check"). |
| A failed scan could look like nothing happened / History lacks context | Failures weren't recorded; History had no capture mode, no completion status, and no explanation of why the text is missing. | Failures are recorded as **"Scan incomplete — not assessed"**, with the reason and no score. History shows capture mode, scan ID, level, score, reasons, hosts and the source line, plus an explicit "Text not stored (privacy)" note with how to opt in to excerpts. The card itself says "Scan incomplete — not assessed" for any failure. |
| "ScamShield got it wrong" report | It was recorded as a **false positive** even on *safe* results, where "wrong" means a *missed* scam: the opposite. Your one report has that wrong meaning stored. | Verdicts offered per result: safe → "It's a scam / It looks suspicious"; warning → also "Not a scam (false alarm)". Your existing report wasn't changed automatically; re-report it if you like. |
| Settings: "The local ScamShield service isn't running." | Settings showed the **last** check result and never re-checked when opened. If the service had been down earlier (it doesn't start after a reboot, and tests had stopped it), the message stayed after it came back. The message also mislabelled timeouts. | Settings re-checks every time it opens and shows "Last checked …". Messages are now specific (nothing answering / running but slow / not ScamShield), with the address and `scripts/scamshield.sh start`. |
| Settings shows "Status — Phase 4" | A static checklist. | Replaced by a live **Components** section from the health check: service, rules, ML model, database, remote AI and Screen Recording permission. |

Also added: a scan-ID diagnostics trail.
- **Mac app** (`dev.scamshield.mac`/`scan`): start, capture size, OCR character count, result or failure.
- **API:** `X-Request-Id`, and a `screen_analysis` line with the block count, rules, ML score and verdict.
- **ML service:** `rid=`.

No message text, screenshot or key is ever logged.

Verified **not** to be causes: History always matched the card (same scan ID and score in every
real-capture run). No exception path produces "safe". Empty OCR becomes "No readable text", never
a result. The risk engine receives OCR text, not sample data. Remote AI still cannot lower the
local score.

## 2. Verification: what kind of test each result came from

**Real screen capture (`ScamShield --scan-eval`).** Each message is shown in a real TextEdit window
and captured with ScreenCaptureKit, then read by Vision OCR, sent to the real local API, and shown
on the real card, with the History record checked for the same scan ID. The fixtures are synthetic
(`tests/fixtures/e2e/messages.json`), and History went to a throw-away folder.

| | Before the fixes | Final (undisturbed run) |
|---|---|---|
| Region scans | 7 / 7 | 6 / 6 where the message was on screen (1 window was off-screen, so no result, correctly) |
| Full-screen scans | **5 / 7** (Hinglish **safe 10**, UPI suspicious 48) | **5 / 5** where the message was visible; Hinglish now **high 62**, UPI critical 95 |
| Card = History (same scan ID) | 14 / 14 | every completed scan |

One intermediate run was disturbed: a browser was in front during the full-screen scans, so the
screen genuinely showed no scam. The harness now records whether the message was actually visible.

**Direct text, not captured** (`scripts/eval-realistic.ts`, `tests/fixtures/eval/realistic-v1.jsonl`,
28 scam / 22 genuine, written by the same author as the rules, so this is coverage, not accuracy):
scams caught **25 → 28 / 28**; genuine flagged **1 → 0 / 22**. System evaluation unchanged:
false-alarm rate on real UCI messages **0.62 %** (4 / 641); scenario suite 25 / 25.

**Automated suites (final):**
- TypeScript **497 passed** (24 files; 64 new rule tests and 21 new screen-analysis tests);
- Swift **119 passed** (111 + 8; new corrective, assembly, history and status tests);
- Python **39 passed**;
- lint 0, typecheck 0, production build compiled;
- migration check passed;
- app self-test **61 / 61** against the live stack, with 0 non-loopback sockets (227 samples).

**Tests changed (all disclosed, all stricter or equal):**
- the safe card now asserts its real reasons and score (previously asserted *no* reasons);
- the unreachable-service message asserts the new exact text;
- a saved debug preference must **not** enable previews (previously asserted it did);
- the API body now includes `source: "screen"`.

**Physical, by you (2026-10-11, about 01:48–01:52):** 10 region scans of fake messages through the
installed app. All were captured, read and analysed (scan-ID logs). About half came back safe; the
diagnostics showed no rule match and ML ≈ 50. That led to the rule gaps fixed above. **Your exact
messages weren't shared, so I can't confirm those specific ones are now caught**; please re-scan
them.

## 3. Remaining / incomplete

- **Physical re-test with your own messages** after these fixes (steps in
  `docs/guides/manual-verification.md` §8).
- **ML-only false alarms remain possible:** a genuine official e-challan with a `.gov.in` link is
  rated **suspicious 40** by the ML model alone (no rule). The ML can't push past "suspicious" on
  its own.
- **Full-screen scans analyse everything visible.** For one message, Select Region is more precise
  (Hinglish: region 75 vs full screen 62).
- **The ML model is weak on the scam domain** (synthetic training data). The rules carry most of
  the detection, so scam types without a rule depend on the model and may only reach "suspicious".
- **Your earlier report** is stored with the old, inverted meaning (see the table above).

## Production-readiness round (2026-10-11)

Design and status of every new component: `docs/design/shared-learning-and-url-intelligence.md`.
Evaluation details: `docs/ml/evaluation.md` §5.

- **Demo code removed from the product.** Sample previews, the mock API, self-test and scan
  evaluation live in `ScamShieldDevSupport` / `DevTools` and compile only with
  `SCAMSHIELD_DEVTOOLS=1` (development builds, `.build-dev`). Debug mode, the PREVIEW menu, the OCR
  text preview and sample badges are gone; the production binary contains no sample texts. Removed:
  legacy `POST /api/scam`, the unused embeddings prototype, the web "Try: …" example buttons, the
  unused `ReportSharing` seam.
- **Why green / orange / red** on every result (card line + full breakdown in History).
- **Scanned text saved in History** by default with numbers, e-mails, UPI IDs and link paths masked
  (switch in History settings).
- **AI second opinion** is the default for new installs after a one-time consent window; local-only
  remains one click away. Free models only; masked text only.
- **Four-option feedback**; old reports migrated (old "got it wrong" on a green result → missed scam).
- **Detection:** 23 new rules (people-impersonation, extortion, gift cards, refunds, accounts,
  subscriptions, tasks, tips groups, macros, water supply…), a safety-tip/news guard and the
  nothing-asked gate. Blind v3 first run: 41/50 scams, 4/50 genuine flagged; after fixes 50/50 and 1/50
  (no longer blind).
- **Shared learning:** opt-in outbox (off by default) → quarantined ingestion API → curation script →
  candidate training → evaluation gate → Ed25519-signed release → verified atomic install / rollback.
  Central server and hosted distribution are not deployed.
- **URL intelligence:** `intel { checked, checkedBy, sources, evidence, confidence, lastUpdated }`
  per link, provider interface, 5-minute cache, "not checked" never shown as clean.
- **Privacy fixes found by new tests:** links written without `https://` kept their path/query in
  History and in the text sent to the remote AI; both now masked.

Test changes (requirement changes, disclosed): analysis-mode tests now assert nothing is remote
without consent (default changed from local-only); feedback tests use the four new options. A test
file (`tests/unit/url-intel.test.ts`, 38 tests) was accidentally overwritten during this round and
restored from the session record; the new URL tests live in `url-reputation-provenance.test.ts`.

Final verification: TypeScript 573 tests, Swift 124 tests + production and development app builds,
Python 39, self-test 62/62 (development build against the live services), migrations additive,
installed app signed with the stable identity, 0 network sockets from the app when idle.

### Clarification round: local + AI together, Unable to assess, training separation, wording

- The pipeline always runs the local engine; with the AI second opinion on, the same scan is also
  sent (masked) to the remote model and both are fused; the AI can raise but never lower the local
  result; every remote failure — including a call that never answers (hard deadline) — returns the
  local result with a notice. Tests: `tests/unit/local-plus-remote.test.ts` (26).
- New `assessment` on every result: when nothing suspicious was found but a detector failed (ML
  unavailable and no AI opinion, or a rule errored), the result is "insufficient" and the Mac app
  and website show **Unable to assess**, never green. Mac tests: `AssessmentTests`.
- Training data from users: only reviewer-ACCEPTED contributions; consensus-only rows go to a
  review queue that training never reads. Scans never modify the installed model (tested).
- Readiness criteria for ever relying on the local model alone: design doc §2.
- Product copy no longer names the provider or says "free", and says "device" instead of "Mac";
  the model ID is no longer shown; older History entries are displayed in the new wording.
- Test changes (wording requirement, disclosed): source-line and headline assertions updated to the
  new copy; curation tests updated to "consensus → review queue, accepted → training".
- Self-test: the menu-bar-only check now finds the test copy by bundle path (the bundle-id lookup was
  ambiguous while the installed app was running, so it had passed or failed by timing).

Verification: TypeScript 600 tests, Swift 129 + both app builds, self-test 62/62 against the live
services, live AI-assisted scan (local + AI fused, assessment complete, no model ID shown).

### Link & threat protection round (2026-10-11)

Design, isolation details and residual risks: `docs/design/link-protection.md`.

- New `POST /api/v1/analyze/link`: canonicalisation (IDN/punycode, defanged, encoded, malformed),
  look-alike checks (now per hyphen-part), SSRF-safe redirect chain, static page and download
  inspection, YouTube official / embed / imitation / wrapper analysis, URLhaus + PhishTank providers
  (inactive until keys are configured), optional isolated page-behaviour inspection, fused by the
  existing risk engine with the local ML model and the AI second opinion (address + findings only).
  Five verdicts with evidence kinds, coverage, limitations and disclosures; on-device-only mode makes
  no outbound request.
- Mac app: **Scan Link…** window (cancellable, explicit "Inspect page behaviour"), Settings switch,
  link entries in History with masked addresses. Website: new link scanner and report view.
- Chromium extension `extension/chromium/` (unpacked): pre-load check via the local service,
  warning page with Go back / Close / Continue-for-this-session.
- Bugs found by real runs and fixed: Playwright launches Chromium in its own process group (cleanup
  now kills by profile path); Playwright proxy-auth stalls heavy pages (per-run secret dropped,
  origin-form requests refused instead); real YouTube search suggestions were misread as data theft
  (now only credential markers sent to another website count); "Go back" looped to the dangerous
  page; the extension cache stored site names; a provider ignoring timeouts could stall a scan;
  "paypa1-secure-login" was not recognised as a PayPal look-alike.
- Tests added: link scan 51, proxy SSRF 18, dynamic inspection 7, extension 14 (unit) + 8 (e2e
  script), Mac 5. Not tested: URLhaus/PhishTank against the live services (no keys), the extension
  in the user's own Chrome/Edge profile, Android/iOS (not built).
