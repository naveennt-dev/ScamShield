# Phase 2 — Screen Scanner + On-Device OCR

Phase 2 turns the menu-bar prototype into a working Shazam-style scanner:

```
Click ScamShield → Scan Screen | Select Region
      → (Screen Recording permission, asked once)
      → [region overlay: drag, confirm]
      → ScreenCaptureKit captures ONE frame (memory only)
      → Apple Vision OCR (on device)
      → text validation (untrusted input)
      → local ScamShield API (127.0.0.1) via ScamShieldAPI
      → result card → image already released
```

Everything is local. No API key, cloud OCR, OpenRouter or paid service is involved.

## Architecture

```
macos/ScamShield/Sources/
├── ScamShieldCore/Scanner/          (testable, no UI)
│   ├── ScannerState.swift            phases, failures, events, pure reducer
│   ├── ScannerCoordinator.swift      orchestrates one user-initiated scan
│   ├── ScreenCaptureService.swift    ScreenCaptureKit single-frame capture
│   ├── ScreenCapturePermission.swift TCC check / one-time request / Settings deep link
│   ├── CaptureTargetSelecting.swift  protocol implemented by the app (overlay, screens)
│   ├── CaptureGeometry.swift         multi-monitor / Retina coordinate math
│   ├── OCRService.swift              Vision VNRecognizeTextRequest (+ one-time prewarm)
│   ├── TextAssembler.swift           reading order, lines, paragraphs, URL-safe cleanup
│   ├── TextValidation.swift          sanitising untrusted OCR text; URL detection (never fetched)
│   ├── TextImageRenderer.swift       renders text to images for tests/self-test
│   ├── PreviewProviders.swift, PreviewScenario.swift   developer previews (sample data)
│   └── ../Networking/AnalysisGate.swift   LocalOnlyGuard (no cloud LLM in backend)
├── ScamShield/Scanner/
│   ├── RegionSelectionService.swift  per-display overlay windows, drag selection
│   └── ScannerPanelController.swift  scanner card (hidden during selection)
└── ScamShieldUI/ScannerView.swift    stage list, text-found, results, failure screens
```

`ScannerCoordinator` depends only on protocols (`ScreenCapturePermissionProviding`,
`CaptureTargetSelecting`, `ScreenCapturing`, `TextRecognizing`, `ScamShieldAPI`, `AnalysisGate`),
so every state is unit-tested with fakes and the real implementations are swapped in by `AppState`.
OCR never talks to the network; only the coordinator calls the API abstraction.

### State machine

```
idle → requestingPermission → selectingRegion (region mode) → capturing → processingOCR
     → textReady → sendingForAnalysis → safe | suspicious → (dismiss) idle
any working state → cancelled | failed(permissionRequired | permissionDenied | captureFailed |
                                       ocrFailed | noTextDetected | analysisServiceUnavailable |
                                       cloudAnalysisEnabled | analysisFailed)
```

`ScannerMachine.reduce` is pure and rejects invalid transitions (late results after dismissal,
double starts). Progress is **stage-based** (Capturing screen → Reading text → Preparing analysis →
Analyzing) — no invented percentages.

## ScreenCaptureKit capture

- `SCShareableContent` → find the `SCDisplay` by display ID → `SCContentFilter(display:excludingApplications:)`
  excluding ScamShield itself (scanner card and overlay never appear in captures).
- `SCStreamConfiguration.sourceRect` = selection in display-local points; `width/height` =
  points × `filter.pointPixelScale` (ScreenCaptureKit's own scale for that display, correct for
  scaled "looks like" resolutions).
- `SCScreenshotManager.captureImage` — one frame, no stream, no recording, no cursor.
- `SCStreamError.userDeclined` → `permissionDenied`; anything else → `captureFailed`.

**Scan Screen** captures the display under the pointer. **Select Region** captures only the
selected rectangle (verified: pixel size of the captured image equals the selection × scale).

## Region selection

- One borderless overlay window per `NSScreen` (multi-monitor), level `.screenSaver`, all Spaces and
  full-screen apps; crosshair cursor.
- Flipped view covering exactly its screen → view coordinates are display-local, top-left points,
  i.e. ScreenCaptureKit's coordinate space. Selection is clamped to that display and snapped
  outwards to whole device pixels (`CaptureGeometry.normalized`).
- Dimmed background with a clear cut-out, white border, live `W × H px` label (exact captured
  pixels), Scan / Cancel buttons after the drag; Return or double-click confirms; Esc cancels;
  selections under 12 × 12 pt are rejected; starting a drag on another display clears the first.
- The scanner card hides during selection so it never covers the message; focus returns to the
  previous app on cancel.

## Vision OCR

- `VNRecognizeTextRequest`, revision 3, `.accurate`, language correction on,
  `automaticallyDetectsLanguage`, languages `en-US` + `hi-IN` (filtered by what the installed model
  supports — Hindi is available on this Mac).
- Runs off the main actor at user-initiated priority; images over 60 MP are refused; images with a
  side under 500 px are upscaled ×2 (small regions).
- **One-time model preparation**: the first recognition in a given app location took ≈ 24–49 s on
  this M-series Mac, then ≈ 0.1 s. `OCRService.prewarm()` runs once at launch in the background
  (utility priority); if the user scans earlier, the card says "Preparing on-device text
  recognition (first scan only…)". Rebuilding in place stays warm; moving/copying the app is cold again.
- Assembly: observations → reading order (top-to-bottom, left-to-right) → rows by ≥ 50 % vertical
  overlap → paragraph breaks where the gap exceeds 1.1 × median line height → whitespace cleanup.
- URL safety: cleanup never edits URL characters, except two narrow repairs: broken schemes
  (`https : //` → `https://`) and, **inside URL tokens only**, `|` → `l` (Vision misreads `#login`
  as `#|ogin`; `|` is not valid unencoded in URLs). URLs are only detected/counted — never opened.

## Untrusted text handling

`TextValidation.prepare`: strips C0/C1 controls and bidi override/isolate characters, normalises
to NFC, collapses blank-line runs, caps to 10 000 characters (backend limit), rejects text with no
letters/digits (`noTextDetected`). Prompt-injection text is kept verbatim as *data*; nothing in the
text can change app behaviour. Logs record phases and counts only — never OCR text.

## Local API integration

The coordinator sends the validated text through the Phase 1 `ScamShieldAPI` abstraction
(`LocalScamShieldAPI.scanMessage` → `POST /api/v1/analyze/message` on 127.0.0.1). The spec
mentions `/api/scam`; the existing abstraction already targets the v1 endpoint, which the backend
provides alongside the (deprecated, unchanged) `/api/scam`, so no API was broken or added.

**Local-only gate (Phase 2 privacy):** before sending, `LocalOnlyGuard` calls `/api/v1/health` and
requires `checks.llm` to be `disabled` or `not_configured`. If the backend has an OpenRouter LLM
active, nothing is sent and the card explains how to run the service locally
(`LLM_ENABLED=false`). Cached for 30 s.

## Permissions & privacy

See `docs/security/macos-permissions.md` and `docs/security/privacy-model.md`. Summary: checked on
every scan (revocation detected), system prompt at most once, then an in-app screen with
"Open System Settings"; one frame per explicit action; image in memory only, released after OCR;
no files written (self-test verifies no new image files).

## How to run

```bash
npx next start -H 127.0.0.1 -p 3000          # local backend (no OPENROUTER_API_KEY / LLM_ENABLED=false)
macos/scripts/build-app.sh && open macos/build/ScamShield.app
# menu bar → Select Region → drag around a message → Scan
macos/scripts/test.sh                         # 71 unit tests incl. real Vision OCR
EXPECT_BACKEND=1 macos/scripts/smoke-test.sh  # in-app self-test (35 checks)
```

If Screen Recording seems ignored after a rebuild (ad-hoc signatures change every build):
`tccutil reset ScreenCapture dev.scamshield.mac`, relaunch, allow again.

## Files

Created: `ScannerCoordinator.swift`, `ScreenCaptureService.swift`, `ScreenCapturePermission.swift`,
`CaptureTargetSelecting.swift`, `CaptureGeometry.swift`, `OCRService.swift`, `TextAssembler.swift`,
`TextValidation.swift`, `TextImageRenderer.swift`, `PreviewProviders.swift`, `PreviewScenario.swift`,
`Networking/AnalysisGate.swift`, `ScamShield/Scanner/RegionSelectionService.swift`,
`Tests/.../OCRAndGeometryTests.swift`, `docs/phases/phase-2.md`, `docs/phases/phase-2-completion.md`.

Modified: `ScannerState.swift` (rewritten), `AppState.swift`, `AppEnvironment.swift`,
`ScannerPanelController.swift`, `SelfTest.swift`, `ScannerView.swift`, `MenuBarView.swift`,
`SettingsView.swift`, `ScamShieldSnapshots/main.swift`, `Tests/.../ScannerTests.swift`,
`scripts/test.sh`, `scripts/smoke-test.sh`, `docs/security/privacy-model.md`,
`docs/security/macos-permissions.md`, `docs/phases/roadmap.md`, `macos/README.md`.

Removed (replaced): `ScanCoordinator.swift`, `ScanPipeline.swift`.

No web/backend file changed.
