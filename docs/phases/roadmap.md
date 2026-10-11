# ScamShield for macOS — 6-Phase Roadmap

ScamShield is a **personal, local macOS menu-bar utility** (Shazam-style): it sits quietly in the
menu bar, and only when the user clicks it (or presses the shortcut) does it look at the screen,
read the visible text and say whether it looks like a scam. Normal content stays quiet.

| Phase | Scope | Status |
|---|---|---|
| **1** | macOS menu-bar foundation: status item, popover, scanner UI + state machine, result screens, global shortcut, local API client abstraction, configuration, privacy/permission design | **Complete** (see `phase-1-completion.md`) |
| **2** | ScreenCaptureKit capture of the current screen, region selection overlay, Apple Vision on-device OCR, temporary image lifecycle, OCR text → local API | **Complete** — multi-monitor hardware test pending (see `phase-2-completion.md`) |
| **3** | Local ML (TF-IDF + LR, calibrated, Python service + embedded fallback) + multilingual rule engine + local risk engine; works offline | **Complete** — see `phase-3-completion.md` |
| **4** | Optional OpenRouter free-model analysis (per-scan opt-in, minimised text, never lowers the local result) + genuinely draggable scanner card | **Complete (engineering)**: live OpenRouter call not yet verified (no API key); see `phase-4-completion.md` |
| 5 | URL intelligence, local scam database, security hardening, privacy controls, scan history | **Complete** — URL intelligence, provenance-aware intel DB, local history & reports, hardening; see `phase-5-completion.md` |
| 6 | Production-like personal build: signing/notarisation options, launch at login, performance, packaging, full testing | **Complete** — install/upgrade/uninstall scripts, durable local database, stable local signing (no notarisation; no launch-at-login by choice), measured performance, physical + offline acceptance; see `phase-6-completion.md` |

The existing Next.js project (`src/`, `prisma/`, `ml/`) is the detection backend and is kept
intact; later phases run it locally and narrow it to what the Mac app needs.
