# ScamShield for macOS

Menu-bar scam scanner (Phase 2 of 6): **Select Region** or **Scan Screen** → ScreenCaptureKit →
Apple Vision OCR → local ScamShield service → result. Everything stays on your Mac.
Docs: `docs/phases/phase-2.md`, status: `docs/phases/phase-2-completion.md`.

```bash
scripts/build-app.sh            # build/ScamShield.app (CONFIG=production hides sample previews)
open build/ScamShield.app       # shield icon appears in the menu bar
scripts/test.sh                 # unit tests (Swift Testing)
scripts/smoke-test.sh           # self-test of the real app (opens/closes its own windows briefly)
cd ScamShield && swift run ScamShieldSnapshots ../build/snapshots   # PNGs of every UI state
```

Requirements: macOS 14+, Swift 6 (Command Line Tools are enough; Xcode optional — open
`ScamShield/Package.swift`).

First scan: macOS asks for Screen Recording permission once (System Settings › Privacy &
Security › Screen & System Audio Recording). After a rebuild, if access seems ignored:
`tccutil reset ScreenCapture dev.scamshield.mac`. Start the local service first
(`npx next start -H 127.0.0.1 -p 3000`, without an OpenRouter key). Debug mode adds
"Preview (sample data)" menu items and shows the extracted text in the scanner card.
