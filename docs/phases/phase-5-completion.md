# Phase 5 Completion Report — URL Intelligence, Scam Intelligence, History & Hardening

Date: 2026-10-10.

**Status: COMPLETE (engineering).** Physical checks are listed separately in §8. The OpenRouter
key and `.env` were not touched in this phase.

## 1. Summary

| Area | What was done |
|---|---|
| URL intelligence | Extended the existing analyser (it already had PSL registrable domains, homographs and punycode, user-info, IP literals and encodings, shorteners, ports, executable paths, and SSRF-safe redirects). **New:** obfuscated ("defanged") links (`example[.]com`, `hxxp://`) are now a visible signal (`url.obfuscated`) instead of being silently repaired. Every link carries a **reputation** (`unknown`, `suspicious`, `confirmed_malicious`, `benign_reports`), and the explanation says "suspicious indicators detected; its reputation is unknown (not a confirmed scam site)" when no record exists. |
| Scam intelligence DB | New provenance-aware `scam_intel` table in the existing PostgreSQL/Prisma setup. A validated **import CLI**; no live feed is bundled (§5). User reports now carry a **verdict** (scam / suspicious / false positive) and create separate `USER_REPORT` records, never confirmations. |
| Mac history | Local **History** window (menu → History…, ⌘Y): recent scans, detail with the reasons, delete one, Clear All (with confirmation), settings. Minimal, redacted data with no text and no screenshots, in a file readable only by your user. |
| Mac reports | "Report this result" (scam / suspicious / false positive) in History, plus a "Details & report…" link on warning cards. Stored **only on this Mac**, with no message text. One per result, at most 30 per day, removable. |
| Hardening | URL query strings and fragments are now stripped from logs, stored previews and remote-AI text. Database-stored text is never shown or obeyed. Tests prove local-only analysis opens zero network connections. The self-test is now immune to stray clicks. |

## 2. Pre-existing issues found (root causes)

1. **Obfuscated links lost their warning value.** `refang()` repaired `example[.]com` before
   analysis, and the obfuscation itself (a classic filter-evasion trick) was discarded.
2. **Domain intelligence couldn't express provenance or certainty.** `scam_pattern` held only
   crowd counts (UNVERIFIED / TRUSTED / REJECTED), with no source type, expiry or review date,
   explanation, or import path. A link with no record and a link with a confirmed record looked
   the same apart from a score.
3. **False-positive feedback had no place to go.** A report could only say "scam".
4. **URL query strings could reach logs.** The log redactor masked digits and e-mails but not
   `?token=…`. Our own error messages never include URLs, but Node network errors can.
5. **The self-test could be disturbed by a person using the Mac** during the real-mouse-event drag
   checks. That happened twice; it was recorded each time and the code was not at fault. The
   panel now keeps ignoring real clicks during those checks (`sendEvent` routing is unaffected).
6. **Two mistakes of my own, caught by the new checks before release:**
   - The new domain-key normaliser at first rejected non-ICANN suffixes that the analyser
     accepts, so records for such domains would never have matched.
   - My first rollback instructions used `prisma migrate resolve --rolled-back`, which only
     applies to *failed* migrations. The rollback script now removes the history rows itself,
     and the migration check proves it works.

## 3. Files changed

**Backend:**
- `prisma/schema.prisma`
- `prisma/migrations/20261010123212_phase5_scam_intel/`
- `prisma/migrations/20261010123446_phase5_report_verdict/`
- `prisma/rollbacks/20261010123212_phase5_scam_intel.down.sql`
- `src/lib/intel/records.ts` (new)
- `src/lib/intel/service.ts`
- `src/lib/url/{extractor,analyzer,service,types}.ts`
- `src/lib/detection/{pipeline,explain}.ts`
- `src/lib/schemas/{analysis,api}.ts`
- `src/lib/services/report-service.ts`
- `src/lib/observability/redact.ts`
- `src/components/analysis/ReportForm.tsx`
- `scripts/intel-import.ts` (new)
- `scripts/verify-migrations.sh` (new)
- `package.json` (`intel:import`, `intel:prune`, `db:verify-migrations`)

**Mac:**
- `Sources/ScamShieldCore/History/{Redactor,HistoryStore,ReportStore}.swift` (new)
- `ScannerCoordinator.swift` (scan id + result hook)
- `Sources/ScamShieldUI/HistoryView.swift` (new)
- `ScannerView.swift` ("Details & report…")
- `MenuBarView.swift` (History… row)
- `Sources/ScamShield/History/HistoryWindowController.swift` (new)
- `AppState.swift`, `AppEnvironment.swift` (History… ⌘Y; the self-test uses a throw-away history folder)
- `MenuBarController.swift`, `SelfTest.swift`

**Tests:**
- `tests/unit/url-intel.test.ts` (new, 38)
- `tests/integration/intel-db.test.ts` (new, 10)
- `tests/security/phase5-privacy.test.ts` (new, 13)
- `macos/ScamShield/Tests/ScamShieldCoreTests/HistoryTests.swift` (new, 14)

**Docs:** this file, `docs/guides/manual-verification.md`.

## 4. Database / schema changes and migration safety

Both migrations are **additive only**:
- `scam_intel` table and three enums: `IntelKind`, `IntelStatus`, `IntelSource`.
- `scam_report.verdict TEXT NOT NULL DEFAULT 'scam'`.

Neither has DROP, DELETE or a type change on existing columns.

`npm run db:verify-migrations` uses a throw-away database. It checks:
1. migrating to the pre-Phase-5 schema and inserting sample user, report and pattern rows;
2. upgrading: rows unchanged, old report gets `verdict='scam'`, `scam_intel` empty;
3. rolling back with the rollback script: rows unchanged, Phase 5 objects gone;
4. re-applying: rows unchanged.

Result: **MIGRATION CHECK PASSED**. On the dev database, the 105 existing rows were identical
before and after.

`scam_intel` design:
- **One row per (kind, key, sourceType)**, so sources never overwrite each other.
- **Keys:** `DOMAIN` uses the registrable domain in lower-case ASCII/punycode (the same parsing
  as the analyser, so `login.sbi.attacker.test` → `attacker.test`). `URL` uses a **SHA-256 of
  the URL without query/fragment**; raw URLs are never stored.
- **Status ceilings by source:** `USER_REPORT` and `LOCAL_RULE` can reach at most SUSPICIOUS
  (confidence ≤ 0.5). Only `IMPORTED_PUBLIC` (an operator-chosen list, ≤ 0.9) and `VERIFIED`
  (manual review, ≤ 0.98) can say CONFIRMED_MALICIOUS. **There is no LLM source.**
- **Data handling:** inputs are Zod-validated; explanations are masked and never shown to users
  (the detail text shown is generated by ScamShield); queries are parameterised through Prisma;
  expired rows are ignored and can be pruned (`npm run intel:prune`).
- **BENIGN** records never add risk and never suppress rule or URL signals.
- **Scan findings are not auto-recorded** as `LOCAL_RULE` rows: storing every scanned domain
  would build a browsing log. The source type exists for future, deliberate use.

## 5. URL intelligence: behaviour and limitations

**Signals** (explainable flags, combined by noisy-OR, then the existing risk engine):
- no TLS (low);
- IP literals, including decimal/hex/octal forms and internal targets;
- user-info tricks;
- brand impersonation and look-alike misspellings;
- homographs and punycode;
- deep subdomains;
- shorteners (medium; never decisive alone);
- suspicious and watch-listed TLDs;
- unusual ports;
- executable downloads and sensitive path words;
- encoded obfuscation;
- **defanged links (new)**;
- **local intelligence matches (new statuses)**.

**Honesty rules:**
- A link with warning signs but no record is described as "suspicious indicators detected;
  reputation unknown (not a confirmed scam site)".
- Nothing is ever described as safe because it is unknown.
- Seven realistic benign messages with links (order tracking, Meet, plain `http://` menu, OTP
  notice, bank debit alert, IRCTC, Hinglish photo link) all stay **safe**.

**Safety:**
- Links are never opened.
- Local scans fetch nothing; redirect resolution exists only for the URL endpoint, behind
  `URL_FETCH_ENABLED=false` (default).
- The SSRF-safe resolver blocks private, loopback, link-local and metadata destinations,
  alternate IPv4 encodings, IPv4-mapped IPv6, and DNS rebinding (pre-flight and connect-time).
  It has bounded redirects, no cookies or auth, and a byte and time budget.

**Limitations:**
- No global threat-intelligence feed is included. I didn't verify any free feed whose terms
  allow this use, so the database holds only what you import or report.
- Brand coverage is the curated list in `src/lib/url/data.ts`.
- Lookalike detection catches homographs and close misspellings, not every lookalike.

## 6. History and report privacy

**History** is stored in `~/Library/Application Support/ScamShield/history.json` (directory 0700,
file 0600).

| Kept | Never kept |
|---|---|
| date, level, score, type, up to 3 redacted reasons, link **hostnames**, local/remote mode and whether the AI was used | screenshot |
| a salted SHA-256 digest (for duplicate detection only) | OCR text (default) |
| an excerpt, only if you opt in: ≤ 140 chars, redacted | full URLs, OTPs, numbers, e-mails, UPI IDs, keys |

- **Duplicates:** the same scan id is never recorded twice. The same content with the same
  verdict within 2 minutes updates the existing entry.
- **Retention:** 7 / 30 / 90 (default) / 365 days, and at most 500 entries.
- **Failures:** a corrupt file is set aside and history starts fresh; storage failures appear in
  the History window and **never block scanning**.
- **Off switch:** turning history off stops recording. Previews and sample results are never
  recorded.

**Reports** are stored in `reports.json` beside the history (0600).
- **Contents:** the verdict, the date, and the result's level, score, type and hostnames, with
  provenance `local-user`. No message text.
- **Limits:** one per result (changing your verdict replaces it), and at most 30 new reports per
  day.
- **Never uploaded.** A `ReportSharing` protocol marks where a future, separately consented
  integration would go; nothing implements it.

On the web API, reports already require sign-in. They now carry a verdict and create a
`USER_REPORT` intelligence record, capped at SUSPICIOUS. A single report never confirms a domain,
and crowd influence still needs 2 or more distinct reporters.

## 7. SSRF and network security

Local-only mode makes no OpenRouter call and no new external call. Phase 5 adds no network
dependency: the import is a local file and lookups hit the local database.

- **Test evidence:** analysing a message full of links calls neither `fetch`, `http.request`,
  `https.request` nor `https.get`.
- **Live evidence:** 0 non-loopback sockets in 126 samples during the full run, and 0 OpenRouter
  events in the server log.
- **Unchanged:** loopback binding, CORS and rate limits. Request size limits and strict schemas
  are tested.
- **Untrusted text:**
  - scanned text that tries to reconfigure ScamShield is scored and flagged, never obeyed;
  - database explanations never reach the user or the AI;
  - the "remote AI never lowers the local score" rule is unchanged and still tested.

## 8. Tests and results

**Automated (mocked or local; no external network):**

| Suite | Result |
|---|---|
| TypeScript, `npx vitest run` (20 files, run twice) | **406 passed** (345 before + 61 new) |
| ESLint / `tsc --noEmit` / `next build` | 0 issues / 0 errors / compiled |
| Python ML, `npm run ml:test` | **39 passed** (1 third-party deprecation warning) |
| Swift, `macos/scripts/test.sh` | **101 passed** (93 core + 8 UI; 14 new history/report/redaction) |
| `npm run db:verify-migrations` | **MIGRATION CHECK PASSED** |
| `npm run intel:import -- sample.csv --source imported --dry-run` | 2 valid, 1 rejected (IP), reported by row number only |

**App self-test against the live local stack** (`EXPECT_BACKEND=1`, default local-only server):
**58 pass, 0 fail, 2 skipped** (real capture; the rebuild needs Screen Recording re-granted). The
new checks:
- only the real scan is recorded (6 previews and 2 mock scans are not);
- the history entry holds no OCR text, URL path or excerpt;
- a local report holds no text;
- the History window is a single instance with the scan selected.

**Egress dry run** (`scripts/offline-check.sh --online`, Wi-Fi on): 0 non-loopback sockets, 0
OpenRouter events.

**Physical:** see the update at the end of this file.

## 9. Known limitations / remaining work

- No bundled threat feed (by design; see §5). The database is only as good as what you import.
- History and reports are per Mac. There's no sync or export, and reports aren't shared anywhere.
- The excerpt (opt-in) is redacted with patterns; unusual personal data formats could slip
  through, which is why it's off by default.
- Brand and lookalike coverage is limited to the curated list.
- Screen Recording must be re-granted after every rebuild (ad-hoc signing).

## 10. Manual verification

See `docs/guides/manual-verification.md` §4–6.

## Update: physical verification (2026-10-10, 18:24–18:25 IST)

You re-granted Screen Recording to the rebuilt app. Then `scripts/offline-check.sh` ran with
**Wi-Fi powered off** (18:24:29–18:25:33) and the stack in its default local-only mode.
Result: **OFFLINE CHECK PASSED.**

- internet unreachable (apple.com and 1.1.1.1 time out);
- ML service and API up, LLM disabled; Hinglish KYC scam → critical 93 via the local ML service;
- app self-test **60 / 60, 0 skipped**, including:
  - real ScreenCaptureKit capture: region 1520 × 720 px with the URL intact, full display
    3024 × 1964 px;
  - real-mouse-event drag checks;
  - all Phase 5 history and report checks;
- **0 non-loopback sockets** (144 samples) and **0 OpenRouter events**.

Wi-Fi was restored automatically afterwards. Four real clicks on the menu-bar icon happened during
the run; they were recorded and affected no check.

Still manual (needs you): browsing the History window by hand (delete, Clear All, settings,
reports). Its logic is covered by automated tests, and the self-test opened it with the scan
selected. See `docs/guides/manual-verification.md` §4–5.
