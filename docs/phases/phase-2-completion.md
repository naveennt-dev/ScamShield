# Phase 2 Completion Report — Screen Scanner + OCR

## Phase 2 Status

**COMPLETE**, with one item **PARTIAL**: multi-monitor support is implemented and unit-tested
for several display arrangements, but this Mac has a single (built-in Retina) display, so it was
**not verified on real multi-monitor hardware**.

Everything runs locally with no API key, no cloud OCR, no OpenRouter and no paid service.

## Implemented

| Area | Status | Evidence |
|---|---|---|
| **Screen Capture** | ✅ Complete | ScreenCaptureKit `SCScreenshotManager` single frame; own windows excluded. Real hardware capture verified: region 1520 × 720 px (= 760 × 360 pt × 2) with the URL read intact from real screen pixels; full display 3024 × 1964 px. |
| **Region Selection** | ✅ Complete | Per-display overlay, dimmed background with cut-out, live exact-pixel label, Scan/Cancel, Return/double-click confirm, Esc cancel, tiny-selection rejection, clamping, pixel snapping. Self-test drives the real overlay view. |
| **OCR** | ✅ Complete | Vision `VNRecognizeTextRequest` (rev 3, accurate, language correction, en-US + hi-IN). Reading order, line grouping, paragraph breaks, URL-safe cleanup. Background prewarm for the one-time model preparation. |
| **Permission Handling** | ✅ Complete | Preflight every scan; system prompt at most once; "Permission Required" / "Screen access unavailable" screens with Open System Settings; revocation detected (preflight and `userDeclined`). |
| **Multi-Monitor Support** | ⚠️ Partial | Overlay window per `NSScreen`, display IDs shared with ScreenCaptureKit, display-local coordinates, per-display scale. Unit tests cover left/above arrangements, negative coordinates, 1×/2×/3× and fractional scales, edge clipping. Not hardware-tested (one display). |
| **Local API Integration** | ✅ Complete | `ScannerCoordinator → ScamShieldAPI → POST /api/v1/analyze/message` on 127.0.0.1. Verified end-to-end: OCR text analysed by the real backend (KYC Scam, score 75). |
| **Privacy** | ✅ Complete | One frame per explicit action; memory only; no files (verified); app excluded from captures; loopback-only API; `LocalOnlyGuard` refuses to send if the backend has a cloud LLM active; no OCR text in app or backend logs (verified). |

Also: the stage-based progress UI (Capturing screen, Reading text, Preparing analysis, Analyzing),
the text-found summary, a developer-only OCR text preview (Debug mode), friendly copy for every
failure, and developer preview scenarios (safe, suspicious, critical, service down, permission, no text).

## Tests Performed

### Automated — Swift (`macos/scripts/test.sh`)
**71 test functions in 14 suites, all passing** (parameterised cases count once), including:

- **OCR (real Apple Vision on rendered images):**
  - plain English multi-line with paragraph breaks (exact text match),
  - URLs `https://sbi-kyc-update.xyz/verify?id=42#login`, `http://192.168.1.10:8080/admin`, `https://bit.ly/3xYz9Q`, `www.paypa1-secure.com/signin`,
  - numbers and punctuation (OTP, amounts, phone numbers),
  - Hindi, mixed English + Hindi, small upscaled text,
  - an empty image, and prompt-injection text kept as data.
- **Text assembly:** reading order, same-line joining, paragraph gaps, URL repair (`https : //`, `#|ogin`), malformed observations (NaN/∞/zero-size/blank), empty input.
- **Validation:** control and bidi characters stripped, Unicode and injection preserved, 10k cap, symbol-only text rejected, URL counting without fetching.
- **Geometry:** drag directions; global → display-local for 3 arrangements; edge clipping; 1×/2×/3× pixel sizes and labels; pixel snapping and clamping; fractional scale; invalid selections; degenerate inputs.
- **State machine:** full region flow, full-screen flow, fail/cancel from every working state, 10 invalid transitions, stage ordering, failure copy.
- **Coordinator (fakes):**
  - a region scan captures only the selected target and sends the OCR text,
  - full-screen scans use the display target,
  - a cancelled selection captures and sends nothing,
  - permission granted / never asked (prompt once) / denied / revoked mid-scan,
  - failure mapping (capture, OCR, empty, symbols, service down, timeout, cloud gate),
  - the gate blocks sending,
  - text is validated before sending,
  - busy and dismiss handling.
- **Permission service:** granted never prompts; prompts at most once, even across instances; revocation detected; Settings URL.
- **Local-only gate:** `not_configured` / `disabled` allowed; `ok` / unknown blocked; unreachable or down.
- **From Phase 1:** configuration, hotkey, settings, API client (stubbed).
- **Live backend** (`SCAMSHIELD_LIVE_API_URL`): 2/2 passing.

### Automated — in-app self-test (`EXPECT_BACKEND=1 macos/scripts/smoke-test.sh`)
35 checks on the real running app, all passing on the final build, with 2 skipped:

- Menu bar item, popover open/close.
- Six preview flows through every state.
- OCR prewarm.
- Overlay on every display; card hidden during selection; tiny selection rejected; Scan/Cancel shown.
- Selection → display-local points and 2× pixel size.
- Region flow through all stages to a result; Esc cancels with nothing captured.
- Real Vision OCR of a rendered scam message: URL intact, paragraphs kept, analysed by the real local backend.
- Permission denied / required screens.
- No image files written.
- Hotkey; Settings; backend reachable; local-only gate (`llm=not_configured`); UIElement app; clean quit.

**Real ScreenCaptureKit capture:** 2/2 passed on the previous build once you granted Screen Recording
(region 1520 × 720 px with the URL intact, full display 3024 × 1964 px). The final build differs
only in close-reason diagnostics, which don't touch capture or OCR. Its grant wasn't re-applied
(ad-hoc signature, see Known Limitations), so on the final binary these two checks report SKIPPED.

### Manual test plan (spec §22)

| # | Item | Result |
|---|---|---|
| 1 | Menu bar icon | ✅ (self-test, LaunchServices UIElement) |
| 2 | Scan Screen works | ✅ real full-display capture (previous build) + flow tests |
| 3 | Select Region works | ✅ real overlay + real region capture; the drag itself is driven by the view's own handlers in tests, not by a physical mouse |
| 4 | Overlay appears correctly | ✅ one per display, frames equal screen frames; visual snapshot |
| 5 | Esc cancels selection | ✅ real key event to the overlay; nothing captured |
| 6 | Screenshot capture works | ✅ hardware (previous build) |
| 7 | Vision OCR extracts text | ✅ rendered fixtures + real screen pixels |
| 8 | URLs remain intact | ✅ incl. `#login` (after the `\|` → `l` URL repair) |
| 9 | Multiple displays | ⚠️ unit-tested only — single display available |
| 10 | Retina scaling | ✅ 2× hardware; 1×/3×/fractional in unit tests |
| 11 | OCR failure handled | ✅ unit tests + preview |
| 12 | No screenshot remains | ✅ self-test file check + code path (memory only) |
| 13 | Local API receives text | ✅ backend analysed OCR text (KYC Scam, 75) |
| 14 | Web project still builds | ✅ lint 0, typecheck 0, build OK, 234/234 tests |
| 15 | No API key required | ✅ backend ran without OpenRouter key; app has no keys |
| 16 | No OpenRouter request | ✅ backend logs: 8 analyses, `llmStatus: unavailable`, 0 OpenRouter attempts; gate enforces it |
| 17 | No continuous monitoring | ✅ only on-demand `captureImage`; no `SCStream`, timers or background capture |

## Known Limitations

- **Multi-monitor not hardware-verified** (see above).
- **Vision's first-run model preparation** takes about 24–49 s, once per app location. It's hidden by the launch prewarm; a scan started in that window shows a "preparing" note.
- **Ad-hoc signing and permissions:** every rebuild invalidates the Screen Recording grant. Use `tccutil reset ScreenCapture dev.scamshield.mac` and re-allow; a stable signing identity belongs in Phase 6.
- **OCR limits:**
  - URLs wrapped across two lines stay split.
  - Low-contrast, stylised or very small text reduces accuracy.
  - Chat layouts with side-by-side bubbles are read row by row.
  - Emoji are mostly dropped.
  - Language correction could "fix" deliberate misspellings in plain words. Domain typosquats such as `paypa1` survived in tests, but this isn't guaranteed.
  - The `|` → `l` repair applies only inside URLs.
- **Hindi** was tested on rendered text, not on real chat screenshots.
- **Backend rate limit:** anonymous clients get 5 analyses per minute (see Phase 1). Frequent scanning will hit it.
- **Whole-display OCR on large monitors** is heavier. Warm OCR of a 1400 × 700 image took about 0.09 s; full-display OCR latency wasn't separately measured. Region mode is the intended default.
- The Phase 2 local-only gate depends on the backend accurately reporting its `llm` state.

## Phase 3 Preparation

- Add a local-client rate-limit tier (or a loopback token) in the backend so personal use isn't capped at 5 per minute.
- Detection improvements (rules, ML, local inference) plug in behind the same `ScamShieldAPI.scanMessage`. The Mac app shouldn't need changes.
- Consider sending OCR line/URL structure (counts, confidence) as optional metadata for scoring.
- Keep `LocalOnlyGuard` until Phase 4 introduces an explicit, user-visible cloud-AI opt-in.
- Real-world OCR evaluation set: screenshots of WhatsApp, Telegram, Messages and browser scams (English and Hindi), stored outside the repo, to measure OCR and detection together.
