# ScamShield for Android

Status: **debug build, sideload / emulator only** — not on Google Play (needs a Play Console account,
a release signing key and a store listing).

## What it does

- Check a **message** (paste it, or *Share → Check with ScamShield* from SMS, WhatsApp, e-mail…) or a
  **link** (only the address is analysed; the website is never opened).
- Runs the **same detection engine** as the desktop app and server (rules, look-alike/link analysis,
  embedded ML model, risk fusion), bundled into the app. Verified identical on every item of the five
  test sets: `npm --prefix mobile run test:parity` → 440/440 identical.
- **Local only, enforced by Android:** the app has no INTERNET permission (also stripped from merged
  library manifests), the page's Content-Security-Policy forbids all connections, backups and device
  transfer are disabled, nothing is stored. No AI second opinion on the phone yet.

## Install the test build (Android 7.0 or later)

The test APK is a **debug build**: it is signed with a development key, not a release key, and it is
meant for testing only. It is not on Google Play and there is no published download yet — when one
exists it will be on the project's [Releases page](https://github.com/naveennt-dev/ScamShield/releases)
with a SHA-256 checksum. Only install an APK from there, never from another site or a message.

1. Download the Android APK attached to a release on the Releases page (once one is published) and
   compare its SHA-256 with the checksum listed there (see "Verify your download" in the [install guide for macOS](install-macos.md#verify-your-download)).
2. Open the file. Android asks whether to **allow installs from this source** (for example
   *Chrome* or *Files*) — allow it for that app only, install, then you can turn the setting off again
   (Settings → Apps → Special app access → Install unknown apps).
3. Open **ScamShield**. It asks for no permissions.

**Use it:** paste a message and tap **Check**, use the **Link** tab for an address, or in any app
long-press a message → **Share** → **Check with ScamShield**.

**Uninstall:** long-press the icon → **Uninstall** (or Settings → Apps → ScamShield → Uninstall).

## Tested so far

On an **Android 15 (API 35) emulator**, arm64, 2026-10-12: install; launch; no network permission
granted (checked with `dumpsys package`); a shared scam SMS → *High-risk scam 95/100*; a shared
look-alike link → *High risk 74/100*; a typed look-alike link → *High risk 70/100*; a genuine message
→ *No scam signs found 0/100*; dark mode. **Not yet tested on physical phones** or older Android
versions.

## Build

Requirements: Node 22, JDK 21, Android SDK (platform 36, build-tools), on macOS/Linux/Windows.

```
cd mobile
npm ci
npm run sync                      # bundles the engine (www/engine.js) and copies it into android/
cd android && ./gradlew assembleDebug    # → app/build/outputs/apk/debug/app-debug.apk
```

Install on a phone with USB debugging: `adb install -r app/build/outputs/apk/debug/app-debug.apk`.

## Not yet

Release signing / AAB for Google Play, screenshot (OCR) scanning, scan history, AI second opinion,
iOS (same `mobile/` project via `@capacitor/ios`; needs full Xcode).
