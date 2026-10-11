# Phase 1 — macOS Foundation

## 1. Existing architecture (inspected before changes)

The repository already contained a Next.js 15.5 application (App Router, TypeScript strict,
Tailwind) that acts as a complete detection backend plus a web dashboard:

- **Detection pipeline** (`src/lib/detection`, `src/lib/risk`, `src/lib/url`, `src/lib/ai`):
  preprocessing → rules (36 + 5 combos) → TF-IDF/LR ML (trained in `ml/`, served in TS) → URL
  analysis (SSRF-guarded) → optional OpenRouter LLM via a model router → risk fusion → explanation.
- **API** `/api/v1/analyze/{message,url,image,email}`, `history`, `reports`, `stats`, `settings`,
  `health`, `metrics`, `cron/retention` with a `{ success, data, meta }` envelope; legacy `/api/scam`.
- **Auth** better-auth (Google OAuth; email/password for local/E2E only). Analysis endpoints allow
  anonymous calls (rate-limited); history/reports require a session.
- **Data** PostgreSQL via Prisma (better-auth tables + analyses, indicators, URL analyses, reports,
  patterns, events); Redis for rate limits.
- **Config** `.env` (documented in `.env.example`); OpenRouter key lives only on the server.
- Docs in `docs/` (architecture, security, ML, API, deployment, testing).

None of it was removed or rewritten in Phase 1.

## 2. Phase 1 architecture

```
macOS (menu bar)
 ├─ NSStatusItem (template shield icon) ──click──► NSPopover ── MenuBarView (SwiftUI)
 │                                                    ├─ Scan Screen   ─┐
 │      Carbon global hotkey (⇧⌘S default) ───────────┼─ Select Region ─┼─► AppState.scan(mode)
 │                                                    ├─ Settings…      └─► ScannerPanel (floating NSPanel)
 │                                                    └─ Quit                    └─ ScannerView (SwiftUI)
 │
 ├─ ScanCoordinator  (@Observable, main actor)
 │     drives ScannerMachine: idle → scanning → analyzing → safe | suspicious | error
 │     using a ScanPipeline = ScreenCapturing → TextRecognizing → ScamShieldAPI
 │       Phase 1: UnavailableScreenCapture (honestly reports "arrives in Phase 2")
 │       Preview: PreviewScreenCapture + MockScamShieldAPI (labelled "PREVIEW · SAMPLE DATA")
 │
 └─ ScamShieldAPI protocol
       LocalScamShieldAPI ──HTTP──► http://127.0.0.1:3000/api/v1/*  (Next.js backend on this Mac)
       MockScamShieldAPI   (sample data for previews/tests)
```

Swift package layout (`macos/ScamShield`), mapped to the requested structure:

| Requested | Implemented |
|---|---|
| `ScamShieldApp.swift` | `Sources/ScamShield/ScamShieldApp.swift` (entry point + AppDelegate) |
| `App/AppState.swift`, `App/AppEnvironment.swift` | `Sources/ScamShield/App/` (+ `SelfTest.swift`); configuration model in `Sources/ScamShieldCore/Config/` |
| `MenuBar/MenuBarView.swift`, `MenuBar/MenuBarController.swift` | `Sources/ScamShieldUI/MenuBarView.swift`, `Sources/ScamShield/MenuBar/MenuBarController.swift` |
| `Scanner/ScannerView.swift`, `Scanner/ScannerState.swift` | `Sources/ScamShieldUI/ScannerView.swift`, `Sources/ScamShieldCore/Scanner/ScannerState.swift` (+ `ScanCoordinator.swift`, `ScanPipeline.swift`, `Sources/ScamShield/Scanner/ScannerPanelController.swift`) |
| `Networking/ScamShieldAPI.swift` | `Sources/ScamShieldCore/Networking/ScamShieldAPI.swift` |
| `Models/AnalysisModels.swift` | `Sources/ScamShieldCore/Models/AnalysisModels.swift` (+ `ResultPresentation.swift`) |
| `Resources/` | App icon is generated at build time from the vector mark (`scripts/build-app.sh`) |
| `Info.plist` | `macos/ScamShield/Info.plist` |

Why three modules: `ScamShieldCore` (Foundation only: state machine, models, config, API, hotkey
model) is unit-testable without UI; `ScamShieldUI` (SwiftUI views) is shared by the app and the
snapshot tool; `ScamShield` (AppKit glue) is the executable.

### Design decisions

- **Swift Package Manager, not an .xcodeproj.** This Mac has only the Command Line Tools (no Xcode).
  SwiftPM builds everything; `scripts/build-app.sh` assembles a real `ScamShield.app` (Info.plist,
  generated icon, ad-hoc signature). The package also opens directly in Xcode if installed.
- **NSStatusItem + NSPopover instead of `MenuBarExtra`.** The popover must close programmatically
  before the scanner panel appears; `MenuBarExtra(.window)` has no API for that.
- **Floating non-activating `NSPanel`** for the scanner: appears over the current app (incl. full-screen
  spaces) without stealing focus; Esc or ✕ closes it; SAFE results auto-dismiss after 4 s so normal
  content stays quiet; warnings stay until dismissed.
- **Carbon `RegisterEventHotKey` for the global shortcut.** Apple's supported mechanism; no
  dependency, no Accessibility/Input Monitoring permission, and it only receives the registered
  combination (no keystroke monitoring). Default ⇧⌘S as requested — note it shadows "Save As…" in
  other apps while ScamShield runs; Settings offers alternatives or Off. Registration conflicts are
  shown in Settings.
- **`@State` avoided.** In the macOS 27 SDK `@State` is a macro whose plugin ships only with Xcode,
  so view-local state uses `@StateObject` to keep the package buildable with the Command Line Tools.

## 3. How the macOS app communicates with the backend

- Only through `ScamShieldAPI` → `LocalScamShieldAPI`, plain JSON over HTTP to the **local**
  ScamShield service: `GET /api/v1/health`, `POST /api/v1/analyze/message`, `POST /api/v1/analyze/url`.
- Base URL from configuration (default `http://127.0.0.1:3000`). The client **rejects any non-loopback
  host** (`127.0.0.1`, `localhost`, `::1` only), so it cannot be pointed at a cloud service.
- App Transport Security allows plain HTTP only for local networking (`NSAllowsLocalNetworking`).
- The app sends no credentials and no cookies. OpenRouter is never called from the Mac app; the key,
  if configured, lives only in the backend's `.env`.
- Responses use the backend envelope; errors map to `ScamShieldAPIError` (unreachable, timeout,
  rate-limited, server message, invalid response).
- Phase 1 usage: Settings → *Test Connection* and the menu footer use the real health check. The
  scanner does **not** call analysis endpoints yet (there is no captured text until Phase 2);
  `scanMessage`/`analyzeURL` are implemented and tested (stubbed and live) for Phase 3.
- Backend notes for later phases: native requests carry no `Origin`, so the backend's CSRF check
  allows them; anonymous rate limits (5/min) apply — Phase 3 should add a local-client tier.
  Run the backend bound to loopback: `npx next start -H 127.0.0.1 -p 3000`.

## 4. Configuration

Precedence: environment (`SCAMSHIELD_API_BASE_URL`, `SCAMSHIELD_ENV`, `SCAMSHIELD_DEBUG`) >
Settings (UserDefaults) > Info.plist (`ScamShieldAPIBaseURL`, `ScamShieldEnvironment`,
`ScamShieldDebug`) > defaults. Invalid values are ignored and listed in Settings. `CONFIG=production`
in the build script sets environment=production and debug=false (hides the sample-data previews).
No secrets are stored anywhere in the app.

## 5. How to run Phase 1

```bash
# Build the app (Command Line Tools or Xcode)
macos/scripts/build-app.sh                    # → macos/build/ScamShield.app
open macos/build/ScamShield.app               # shield icon appears in the menu bar

# Optional: local backend for the connection check
npx next start -H 127.0.0.1 -p 3000           # after `npm run build`

# Tests
macos/scripts/test.sh                         # Swift unit tests (ScamShieldCore)
SCAMSHIELD_LIVE_API_URL=http://127.0.0.1:3000 macos/scripts/test.sh --filter Live
macos/scripts/smoke-test.sh                   # launches the real app in self-test mode
EXPECT_BACKEND=1 macos/scripts/smoke-test.sh  # also checks the app reaches the backend

# Visual review of every state (light/dark) without screen access
cd macos/ScamShield && swift run ScamShieldSnapshots ../build/snapshots
```

In the development build, **Debug mode** adds "Preview (sample data)" items to the menu to walk
through Safe / Suspicious / Critical / Error. Every preview result is labelled
"PREVIEW · SAMPLE DATA". "Scan Screen" and "Select Region" honestly report that capture arrives in
Phase 2 — nothing is captured.

## 6. Files

Created: everything under `macos/` (package, sources, tests, Info.plist, scripts),
`docs/phases/phase-1.md`, `docs/phases/phase-1-completion.md`, `docs/phases/roadmap.md`,
`docs/security/privacy-model.md`, `docs/security/macos-permissions.md`, `macos/README.md`.

Modified: `.gitignore` (macOS build outputs), `README.md` (macOS section). No web/backend source
files were changed.
