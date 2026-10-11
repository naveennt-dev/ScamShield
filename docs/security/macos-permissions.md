# macOS Permissions

Phase 1 requested no permissions. **Phase 2 uses exactly one: Screen Recording**, only when the
user starts a scan. No Accessibility, Input Monitoring or other permission is used (no
CGWindowList, AX, or event-tap APIs in `macos/`).

| Permission | Needed? | When | Why / how |
|---|---|---|---|
| **Screen Recording** (Privacy & Security › Screen & System Audio Recording) | **Yes (Phase 2, implemented)** | First time the user starts a scan — never at launch | ScreenCaptureKit (`SCScreenshotManager`) captures the current display or a selected region once per user action. See flow below. No Info.plist usage string is required for this TCC category. |
| Accessibility | **No** (not planned) | — | Not needed: the global shortcut uses Carbon `RegisterEventHotKey`, which works without it. Region selection is our own overlay window. Reading other apps' UI via the Accessibility API would be more invasive than OCR and is deliberately avoided. |
| Input Monitoring | **No** | — | We never observe keystrokes; only the one registered hotkey is delivered to us. |
| Network (outgoing) | Not a TCC permission | — | Only to the local service on 127.0.0.1. ATS allows plain HTTP only for local networking. If the app is sandboxed later (Phase 6), it needs `com.apple.security.network.client`. |
| Notifications | Maybe (Phase 5/6) | When enabling | Only if we add optional notification-style results. |
| Files / Photos / Camera / Microphone / Location | **No** | — | — |

## Screen Recording flow (implemented — `ScreenCapturePermission`)

1. Every scan calls `CGPreflightScreenCaptureAccess()` (no prompt). Granted → continue.
2. Never asked before → `CGRequestScreenCaptureAccess()` once (macOS shows its prompt), the flag
   `screenCapturePermissionRequested` is stored, and ScamShield shows
   **"Screen Recording Permission Required"** with *Open System Settings*.
3. Asked before and still not granted (denied or **revoked**) → no prompt; ScamShield shows
   **"Screen access unavailable"** with *Open System Settings*
   (`x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`).
4. If ScreenCaptureKit itself reports `userDeclined` mid-scan (revoked between check and capture),
   the same screen is shown.
5. macOS may require relaunching the app after granting; the screen says so.

No private APIs, no bypasses, no repeated prompts.

## Notes from testing

- **Ad-hoc signing resets the grant.** Each rebuild produces a new code signature, and macOS keeps
  the old entry, so a toggle in System Settings may not apply to the new build. Fix:
  `tccutil reset ScreenCapture dev.scamshield.mac`, relaunch, allow again. A stable signing
  identity (Phase 6) removes this.
- Recent macOS versions may periodically ask the user to re-confirm screen-recording access for
  apps; that prompt comes from the system and is expected.
- The terminal used for development does not hold Screen Recording; real-capture verification ran
  inside the app after the user granted access.
