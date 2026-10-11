# Privacy Model — ScamShield for macOS

ScamShield is a personal tool that looks at what is on your screen. That is sensitive, so the
design rule is: **it sees the screen only when you ask it to, keeps as little as possible for as
short as possible, and processes locally wherever it can.**

## Principles

1. **No continuous monitoring.** No background capture, no timers, no "watch mode", no observation
   of other apps' windows or keystrokes. ScamShield is idle until you click the menu-bar icon,
   choose *Scan Screen* / *Select Region*, or press the shortcut.
2. **Explicit activation, one capture per action.** Each user action produces at most one capture
   of the current screen or the region you select.
3. **Temporary images.** Captures stay in memory only; they are never written to disk, never sent
   anywhere, and are released immediately after on-device OCR.
4. **Local processing first.** OCR runs on the Mac (Apple Vision). Detection runs in the local
   ScamShield service on the same Mac (rules + ML). The Mac app only talks to `127.0.0.1`.
5. **Optional remote AI, off by default, explicit per scan (Phase 4).** Remote analysis needs all
   of the following:
   - the service has it enabled (`LLM_ENABLED=true`, an API key, a free model);
   - the account setting allows it (`allowLlmAnalysis`);
   - **this scan asks for it** (`analysisMode: "remote-assisted"`): the Mac setting "On this
     Mac + remote AI", or the web per-scan checkbox, both off by default.

   Only minimised extracted text is sent, never the image: links are cut to their domain;
   digits, e-mails, UPI IDs and keys are masked; at most 3,000 characters. The Mac app never
   holds the key and never calls OpenRouter.
6. **Minimum retention.** Results are shown and dismissed. Any history (Phase 5) stores verdicts and
   masked previews only, with user-controlled retention and delete-all.
7. **No telemetry.** No analytics, crash reporting or cloud services in the app.

## Scan flow (implemented in Phase 2)

```
User clicks Scan Screen / Select Region / presses the shortcut
        ↓
Screen Recording permission checked (every scan; system prompt shown at most once)
        ↓
[Select Region] user drags a rectangle on a dimmed overlay — Esc cancels, nothing captured
        ↓
ScreenCaptureKit: ONE frame of the display or ONLY the selected rectangle
   (ScamShield's own windows excluded; no stream, no recording, no cursor) → memory only
        ↓
Apple Vision OCR on device → text
        ↓
Image released (it never leaves the capture/OCR scope; nothing written to disk)
        ↓
Text validated as untrusted input → sent ONLY to the local ScamShield service on 127.0.0.1
   with analysisMode "local" (default) or "remote-assisted" (only if the user chose it in Settings)
   (local-only gate: refused if the service could consult a remote AI without being asked)
        ↓
Result shown: SAFE quietly (auto-dismiss) or a strong warning → back to idle
```

### How this is enforced and verified

| Guarantee | Mechanism | Verification |
|---|---|---|
| No continuous monitoring | Capture only inside `ScannerCoordinator.run`, started only by a menu action or the hotkey; no timers, no streams | Code review; only `SCScreenshotManager.captureImage` is used (no `SCStream`) |
| One frame per action | Single `captureImage` call per scan; busy scans ignore further starts | Unit tests (coordinator) |
| Region only | `sourceRect` = selection; image size = selection × scale | Self-test + hardware test (1520 × 720 px for a 760 × 360 pt window) |
| No files | Image kept as `CGImage` in a local scope; never encoded | Self-test: no new image files in temp/cache dirs |
| Own windows not captured | `SCContentFilter(excludingApplications: [ScamShield])` | Code review |
| Text stays local (default) | `ScamShieldAPI` → loopback-only URL, `analysisMode: "local"` on every request; backend calls no AI provider unless the request opts in; `LocalOnlyGuard` refuses a backend whose `llm` state isn't `disabled`/`not_configured`/`opt_in` | Unit + API tests (provider never called, no fetch); live check: 0 non-loopback sockets |
| No content in logs | App logs phases/counts only; backend logs scores, not text | Backend log audit: scanned text absent |

## What can leave the Mac (Phase 4, only after the user opts in)

This applies only when **both** the service has remote analysis enabled **and** the user has chosen
"On this Mac + remote AI" in Settings (or ticked the web per-scan box).

**What is sent:** the minimised OCR text of a scan the user started, plus the local rule
descriptions as hints. It goes from the local service to OpenRouter and the free model's provider,
which may log it; free models in particular may use prompts for training.

**What is never sent:**
- screenshots or images;
- full URLs, digits (OTPs, card/account/phone numbers), e-mail addresses, UPI IDs or keys;
- other windows, conversation history or credentials.

**Transparency:** the result card states whether the remote AI was used, and why not when it
wasn't. Turning the setting off makes the next scan local-only.
