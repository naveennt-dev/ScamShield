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
