# macOS Liquid Glass — implementation and verification (2026-10-12)

Branch `feature/macos-liquid-glass` (from `feature/lookalike-detection`). Tested on **macOS 27.0.1
(build 26A434), Apple silicon**, SDK 27.0 (Command Line Tools). **Not tested on macOS 14–25** (no such
machine): those systems take the pre-existing code paths, guarded by `#available(macOS 26, *)`, and
the macOS 26 symbols are weak-linked (verified with `nm -m -u`: 13/13 weak).

## What uses Liquid Glass (macOS 26+)

| Element | API | macOS 14–25 |
|---|---|---|
| Menu-bar popover container | System `NSPopover` Liquid Glass — enabled by linking against the real SDK (below) | unchanged |
| Popover content | window-coloured readability backing over the glass (contrast) | unchanged |
| Menu row highlight | solid `Theme.menuHighlight` (white-on-tinted-glass failed contrast) | unchanged (brand colour) |
| Scanner card | `glassEffect(.regular.tint(windowBackground 0.9), in: RoundedRectangle(26))` | `.regularMaterial` + hairline (unchanged) |
| Scanner ✕ | `.buttonStyle(.glass)` + `.buttonBorderShape(.circle)` | quaternary circle (unchanged) |
| Done / Dismiss / Open System Settings / Close (default) | `.buttonStyle(.glassProminent)` | default bordered |
| Try Again / secondary Close | `.buttonStyle(.glass)` | default bordered |
| Settings, History, Scan Link windows | system controls in the macOS 26 design (via the SDK fix) | unchanged |

**SDK fix.** With the Command Line Tools, SwiftPM's final link recorded `sdk 14.0` (the deployment
target) instead of 27.0, so macOS ran the app in the old compatibility design (opaque popover).
`Package.swift` now passes `-platform_version macos 14.0 <SDK>` when `SCAMSHIELD_SDK_VERSION` is set;
`build-app.sh` sets it from `xcrun --show-sdk-version` and fails the build if the binary records a
different SDK.

**History window** now uses `.fullSizeContentView`: with the macOS 26 design, AppKit and SwiftUI both
inset for the toolbar and the first section heading was blurred under it.

## Contrast (WCAG 2, measured on real captures over a deliberately busy backdrop)

Tool: `contrast` (median background vs 3rd/97th-percentile text luminance per text block).
AA: 4.5:1 normal text, 3:1 large text (headline, score).

| Text | Light | Dark |
|---|---|---|
| Menu labels | 11.2–11.5 | 6.9–7.3 |
| Menu shortcuts / footer | 5.1–5.2 | 5.2–5.4 |
| Menu mode label ("Remote AI assist on") | **4.47** (0.03 below AA) | 5.39 |
| Highlighted row label / shortcut | 4.55 | 4.55 |
| Scanner headline (critical, large) | 4.97 | 6.19 |
| Scanner score (large) | 5.05 (critical) · 5.10 (suspicious) | 6.57 · 9.74 |
| Scanner captions / reasons / actions | 9.1–21.0 | 9.9–14.8 |
| "Details & report…" link | 5.11 | 7.75 |

Before (old material, light): headline 2.38, score 2.44, link 3.11. (The "before" dark critical
capture missed the card and is excluded.)

## Screenshots

Real window-server composites of ScamShield's own windows only (ScreenCaptureKit, synthetic backdrop,
sample data; nothing else on screen is captured) — development build, `--ui-capture <dir>`:

- before (pre-change code, SDK recorded as 14.0): `macos/build/ui-verification/before/` — menu + 4
  scanner states × light/dark (10 files; dark critical lacks the card).
- after: `macos/build/ui-verification/after/` — menu, highlighted menu, 4 scanner states and the
  Settings / History / Scan Link windows × light/dark (18 files) + `capture-report.json`.

Both sets: macOS 27.0.1 (26A434). Not committed (build folder); regenerate with the command above.

## Not verified

macOS 14–25 rendering; "Reduce transparency" / "Increase contrast" on (system-handled, not toggled);
VoiceOver; full keyboard-only navigation of the popover (focus ring visible on the first row, Tab
traversal not exercised); the popover's appearance on a real light/dark menu bar (forced per capture).
