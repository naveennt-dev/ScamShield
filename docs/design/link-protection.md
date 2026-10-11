# Link & threat protection — design, isolation and limits

Status as of 2026-10-11. **Runs** = implemented and exercised on this Mac; **Interface only** =
code and tests exist but needs configuration/infrastructure; **Not built**.

## 1. Where it lives

| Surface | Status | How |
|---|---|---|
| `POST /api/v1/analyze/link` (local service) | Runs | `src/lib/linkscan/scan.ts` |
| Mac app → menu → **Scan Link…** | Runs (built, installed; UI not visually verified by me) | `LinkScanWindowController`, `LinkScanView` |
| Website → Scan URL | Runs (builds; not opened in a browser by me) | `ScanUrl.tsx`, `LinkReportView.tsx` |
| Chromium extension "ScamShield Link Guard" | Runs — tested end-to-end in Playwright's Chromium against the live local service | `extension/chromium/` |
| Android / iOS system-wide protection | **Not built** — not claimed | — |

## 2. Pipeline (one link)

1. **Canonicalise** without network: trims junk, restores defanged forms (`hxxp`, `[.]`), removes
   invisible/bidi characters, rejects control characters, IDN ⇄ punycode (both shown), decodes
   %-encoded hosts, drops fragments and default ports, rejects non-web schemes (`javascript:`,
   `data:`, `file:` … are reported as dangerous), length cap.
2. **Static URL heuristics**: brand look-alikes (now also per hyphen-part: `paypa1-secure-login`),
   homographs, punycode, shorteners, IP/obfuscated IPs, internal targets, risky TLDs, `@` tricks,
   executable paths, encodings; YouTube relationship (official / YouTube redirect / imitation).
3. **ScamShield intelligence** (local database, domain level).
4. *(online only)* **SSRF-safe fetch**: redirect chain hop by hop, each hop re-validated; then
   **static page inspection** (forms and where they post, password/card/OTP fields, frames incl.
   YouTube embeds and hidden frames, external scripts, meta/script redirects, download links, fake
   prompts, obfuscated scripts, script capabilities) or **download inspection** (magic bytes vs
   extension vs MIME, double extensions, macro documents, SHA-256 of fully read files — never
   written to disk, opened or executed).
5. *(online only, configured only)* **URL threat feeds**: URLhaus, PhishTank — Interface only until
   a key is set in `.env` (`URLHAUS_AUTH_KEY`, `PHISHTANK_APP_KEY`). They receive
   `scheme://host/path` only. Cache 15 min, timeout 4 s (hard race), 20 lookups/min each. A failure
   is reported as a failed check, never as "not listed". **Not tested against the live services**
   (no keys); parsers tested with recorded response shapes.
6. *(explicit click per scan)* **Isolated page-behaviour inspection** — §4.
7. **Existing engine**: page/download/intel/behaviour findings enter the existing risk engine as
   deterministic signals next to the URL analyser, local rules (on the page text), the installed ML
   model and — when on — the AI second opinion, which receives only the website address(es) and the
   list of findings (no page content, no path, no query) and can raise but never lower the result.
8. **Verdict** — §5.

"On this device only" makes **no outbound request**: steps 4–6 and the AI are skipped and reported
as skipped (tested: transport, feeds and AI are never called).

## 3. SSRF protection

Every server-side request (static fetch and the inspection browser's proxy) goes through
`assertSafeUrl` + connect-time validation: http/https only; ports 80/443; no credentials; no
internal names (`localhost`, `*.local`, `*.internal`, metadata names, single-label, non-public
suffixes); every resolved address must be public unicast — loopback, private, CGNAT, link-local
(169.254.169.254), reserved, multicast, IPv6 ULA/link-local (incl. `fd00:ec2::254`), IPv4-mapped
IPv6, decimal/hex/octal IPv4 forms are refused; a mixed DNS answer is refused; sockets connect to
the address that was validated (no second lookup → no DNS rebinding); limits on redirects, time,
bytes, connections. Tests: `tests/security/ssrf.test.ts` (61), `tests/security/inspection-proxy.test.ts`
(18), `tests/unit/linkscan.test.ts` (redirect re-validation, protocol/port redirects, cancellation).

## 4. Isolated page-behaviour inspection

**Off by default since the release audit (2026-10-11)**: the service enables it only with
`SCAMSHIELD_DYNAMIC_INSPECTION=1`, and the app offers the button only after Settings → Analysis →
"Offer Inspect page behaviour" is switched on. Per inspection (explicit click):

- a **new SSRF-filtering proxy** on 127.0.0.1 (random port, alive only for this run, proxy-form
  requests only — an ordinary web page cannot use it; full SSRF policy per connection);
- a **separate worker process** with a minimal environment (no API keys, database URLs or other
  secrets), CPU-time limit (120 s) and file-size limit (~200 MB), hard deadline (default 20 s + 5 s);
- a **new empty Chromium profile** (deleted afterwards), **Chromium's sandbox on**, all traffic via
  the proxy with no loopback bypass, **Chromium's own DNS disabled** (`MAP * ~NOTFOUND`), QUIC off,
  WebRTC limited to proxied traffic, background networking/sync/component updates off, mock
  keychain (the user's keychain is never touched), downloads cancelled, all permissions denied
  (notifications, camera/mic, location, clipboard, saved credentials, file pickers, USB/Bluetooth/
  serial, push) and logged, dialogs dismissed, pop-ups closed, service workers blocked;
- **synthetic data only**: unique marker values are typed into up to 3 visible fields; nothing is
  submitted and Enter is never pressed. "Typed data stolen" requires an e-mail/password marker
  reaching a **different website**; search-box text reaching the site's own servers is normal and
  ignored (found and fixed on real YouTube).
- **cleanup on every path** (completion, error, crash, timeout, cancellation): the worker's process
  group is killed, every process using the run's profile path is killed (Playwright starts Chromium
  in its own process group — found and fixed), the profile is deleted, the proxy is closed. One
  inspection at a time.

Verified (`tests/integration/dynamic-inspection.test.ts`, local fixtures only): typed-data
exfiltration detected; search suggestions not flagged; prompts, auto-downloads and permission
requests reported; every SSRF attempt from page scripts blocked (loopback, IPv6 loopback, decimal and
hex IPv4, `localhost`, `10.x`, metadata IP, WebSocket); **zero UDP packets** from WebRTC; **every TCP
connection of Chromium and its helper processes went to the proxy port** (sampled with `lsof`);
cancellation and time limit; no leftover processes or profiles. Live (benign sites only):
`example.com` and a YouTube video page inspected end-to-end through the proxy.

**Residual risk — read this.** This is not a virtual machine. On macOS an outer OS sandbox
(`sandbox-exec`) cannot be combined with Chromium's own sandbox (verified: Chromium does not start
nested), so there is no OS-level network wall around Chromium; confinement relies on Chromium's
proxy/resolver settings plus the proxy's policy, and Chromium runs as your user account (macOS
offers no unprivileged user without admin rights). A Chromium vulnerability could compromise this
Mac. A per-run proxy password was tried and dropped (Playwright's proxy-auth handling stalls heavy
pages); during an inspection another program running as you could use the proxy, but only to reach
public websites. Behaviour is observed for a few seconds with synthetic data — later behaviour,
behaviour after a real login, or device-specific behaviour is not observed. Use it on links you
would not open anyway; turn it off with `SCAMSHIELD_DYNAMIC_INSPECTION=0` or in Settings.

## 5. Verdicts

| Verdict | Requires |
|---|---|
| Malicious | Confirmed intelligence (a configured feed lists it, or ScamShield's verified list) **or** observed theft of typed test credentials to another website |
| High risk | The fused risk is high/critical (several strong indicators, e.g. look-alike + credential form posting elsewhere, disguised executable) |
| Suspicious | Meaningful but inconclusive indicators |
| No known threat detected | The checks that ran found nothing — always shown with "not a guarantee" and the coverage table |
| Inconclusive | Malformed input, page/redirect/behaviour check failed or timed out, or a local detector failed |

Every report lists evidence labelled **Confirmed / Observed / Warning sign / AI opinion**, per-type
results (phishing, scam, malware download, redirects, other), the coverage of each check (checked /
skipped / failed / unavailable), limitations, and everything that left the device.

## 6. Browser extension (Chromium, Manifest V3) — `extension/chromium/`

Install: `chrome://extensions` (or `edge://extensions`) → Developer mode → **Load unpacked** →
choose `extension/chromium`. The local service must be running (`scripts/scamshield.sh start`,
which sets `ALLOW_BROWSER_EXTENSION=true`). Not published to any store.

- Top-level http(s) navigations are checked **before the page finishes loading** by the local
  service in on-device-only mode (address only; `scheme://host/path` is sent, no query/fragment,
  nothing leaves the device). High risk / Malicious → warning page with **Go back to safety**
  (returns to the tab's last checked page), **Close this tab**, and a de-emphasised **Continue
  anyway** that allows that one site for this browser session.
- Privacy: verdict cache keyed by a hash, allowed pages cached without their names; per open tab
  only the last checked page (for "Go back"); all in session storage (cleared when the browser
  closes). Private/incognito windows are never checked (`"incognito": "not_allowed"`).
- **Cannot intercept / limitations**: MV3 cannot block a navigation synchronously — the page may
  start loading (requests may be sent) before the warning replaces it; sub-frames, `fetch`/XHR,
  downloads started by pages, links opened by other apps before the browser, non-Chromium browsers,
  and navigations during the extension's service-worker start-up are not checked; if the ScamShield
  service isn't running, links are not checked (the toolbar badge shows "!"). The service's
  origin rule accepts `chrome-extension://` only for `/api/v1/analyze/link`, only from this machine,
  only with `ALLOW_BROWSER_EXTENSION=true`.
- Tested: logic (14 unit tests) and end-to-end in **Playwright's Chromium** against the live local
  service (`npx tsx scripts/e2e-extension.ts`, 8 checks). **Not tested in your own Chrome/Edge
  profile.**
