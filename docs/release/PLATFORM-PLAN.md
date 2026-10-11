# ScamShield platforms — status and plan (2026-10-11)

Decisions (owner): macOS first; Tauri for Windows/Linux desktop and Capacitor for Android/iOS later;
no paid Apple Developer Program yet.

## Shared architecture

```
shared TypeScript core (src/lib/detection, src/lib/linkscan, src/lib/url, ml/models/*.json)
 ├─ desktop "ScamShield Engine" = Next.js standalone server + official Node.js runtime, bundled
 │   in the app, started/stopped by it (no PostgreSQL/Redis/Python; embedded ML model)
 │     ├─ macOS: native Swift app (menu bar, Vision OCR, ScreenCaptureKit)        ← BUILT
 │     ├─ Windows / Linux: Tauri shell (tray, WebView UI, Rust capture/OCR glue)   ← planned
 │     └─ Chromium extension talks to the engine on 127.0.0.1:3000                ← BUILT
 └─ mobile: Capacitor app runs the same core on-device (offline local analysis);   ← planned
     AI second opinion optional via a hosted ScamShield service (not built)
```

Server secrets are never embedded in clients: the optional AI key is entered by the user and kept
in the OS keychain (macOS done; Windows Credential Manager / Android Keystore / iOS Keychain planned).

## Status

| Platform | Status | Verified on | Blocking for public distribution |
|---|---|---|---|
| macOS (Apple silicon) | **Self-contained app + DMG built** | This Mac (macOS 27, M4): DMG install to a test folder, launch without Terminal, engine start/scan/quit, crash recovery, orphan cleanup | Developer ID signing + notarization (paid Apple Developer Program); Intel build not made |
| Chromium extension | Built, zip packaged | Playwright Chromium vs live engine | Store listing (needs approval) |
| Windows | Not built | — | Needs Windows CI runner or PC; code-signing certificate |
| Linux | Not built | — | Docker available for headless builds; tray support varies by desktop |
| Android | Not built | — | Android SDK install (~5 GB); Play Console account for AAB |
| iOS / iPadOS | Not built | — | Full Xcode; paid Apple Developer Program for devices/TestFlight/App Store |

## Next stages

1. **Core package**: move the detection core into `packages/core` with a platform-neutral API
   (no Next.js imports), keep the web/engine using it; add contract tests shared by all shells.
2. **Windows (Tauri)**: tray + floating scanner, Windows.Graphics.Capture + Windows.Media.Ocr,
   engine sidecar (same Node bundle for win-x64), NSIS/MSI installer, Mica styling; build and test on
   GitHub Actions `windows-latest` (requires a private repository — your approval).
3. **Android (Capacitor)**: paste/share-sheet link scanning with the core on-device, Keystore-held
   AI key, signed APK + AAB; emulator tests.
4. **iOS/iPadOS (Capacitor)**: share extension + paste, Keychain, App Store privacy manifest;
   requires Xcode and the paid programme.
5. **Linux**: AppImage/DEB via Tauri; document tray limits.
