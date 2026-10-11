# Release process

Nothing is released until every gate below passes **and the owner approves the exact files by
SHA-256**. Binaries go to a GitHub Release — never into the source history. Signing keys and passwords
never enter the repository, CI logs or chat.

The downloads page (`docs/site/`) needs no manual edit: it reads the newest published release from the
GitHub API and shows a download button only for an asset that has the expected name, comes from this
repository's release downloads, and has a GitHub-computed SHA-256 digest.

## One-time setup (owner)

| What | Where it lives | Cost |
|---|---|---|
| **Android release key** — `keytool -genkeypair -keystore scamshield-release.jks -storetype PKCS12 -alias scamshield -keyalg RSA -keysize 4096 -validity 10000` | Outside the repository; **back it up offline** — losing it means you can never update the app for existing installs | Free |
| `mobile/android/keystore.properties` (git-ignored): `storeFile=/abs/path/scamshield-release.jks`, `storePassword=…`, `keyAlias=scamshield`, `keyPassword=…` — or the four `SCAMSHIELD_ANDROID_*` environment variables | Release Mac only | — |
| **Apple Developer Program** membership → a **Developer ID Application** certificate in the login keychain (the "Apple Development" certificate cannot be used for public distribution) | developer.apple.com / Keychain | Annual fee (shown on Apple's enrollment page) |
| Notary credentials: `xcrun notarytool store-credentials scamshield-notary --apple-id <id> --team-id <TEAMID>` (app-specific password from appleid.apple.com) | macOS keychain | Included |
| Google Play (only for a Play Store listing) | play.google.com/console | US$25 one-time |

## 1. Prepare the release commit
- [ ] `main` CI green (web-and-engine, macos-app, android-debug-apk).
- [ ] Version `X.Y.Z` set in `package.json`, `macos/ScamShield/Info.plist` (`CFBundleShortVersionString`),
      `mobile/android/app/build.gradle` (`versionName`, and `versionCode` +1); `CHANGELOG.md` entry.
- [ ] History-wide secret scan of the release commit.

## 2. Android (Android 7.0+)
```
cd mobile && npm ci && npm run sync
cd android && ./gradlew assembleRelease bundleRelease     # fails if release signing isn't configured
```
- [ ] Physical devices: at least one older (Android 7–9) and one current phone — install, paste, share
      from Messages/WhatsApp, link check, dark mode, uninstall. (Done so far: Android 15 emulator only.)

## 3. macOS (Apple silicon, macOS 14+)
```
export SCAMSHIELD_SIGN_IDENTITY="Developer ID Application: <Name> (<TEAMID>)"
CONFIG=production REBUILD_ENGINE=1 macos/scripts/build-app.sh   # secure timestamps for Developer ID
macos/scripts/build-dmg.sh
macos/scripts/notarize.sh                                       # notarize, staple, Gatekeeper check
```
- [ ] On a second Mac (or a fresh user account): download, open — no "unverified developer" dialog —
      first scan, Screen Recording prompt, quit.

## 4. Package and verify (refuses anything unverified)
```
scripts/release/package-release.sh X.Y.Z \
  --macos macos/build/ScamShield-X.Y.Z.dmg \
  --android mobile/android/app/build/outputs/apk/release/app-release.apk \
  --aab mobile/android/app/build/outputs/bundle/release/app-release.aab
```
Refuses a debug-signed or debuggable APK, an APK with network permissions, a DMG without a stapled
ticket or Developer ID signature, a Gatekeeper rejection, or a version mismatch. Writes
`dist/release-vX.Y.Z/` (git-ignored): renamed assets, `SHA256SUMS.txt`, `RELEASE_NOTES.md`.

## 5. Publish (owner only)
- [ ] Review and edit `RELEASE_NOTES.md`; approve the checksums.
- [ ] `gh release create vX.Y.Z --draft …` (printed by the script) — or create the release in the GitHub
      web UI and attach the same files. Review the draft, then **Publish**.
- [ ] Re-download each asset from the release page and compare with `SHA256SUMS.txt`.
- [ ] The downloads page picks the release up automatically; deploy it with the manual
      "Downloads page" workflow (Pages must be enabled once in repository settings).

Windows, Linux desktop and iOS have no distributable yet; they stay "Planned".
