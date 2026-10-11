# Release checklist

Nothing is released until **every** box for that platform is checked and the owner has approved the
exact files (by SHA-256). Binaries are attached to a GitHub Release — never committed to the source
history. The downloads page (`docs/site/releases.json`) is updated only after the release exists.

## 1. Prepare (any platform)
- [ ] `main` CI green (web-and-engine, macos-app, android-debug-apk) on the release commit.
- [ ] `CHANGELOG.md` entry; version numbers match (`package.json`, macOS `Info.plist`,
      Android `versionName`/`versionCode`).
- [ ] History-wide secret scan of the release commit; artefact scan (no `.env`, keys, user data,
      build-machine paths) — `build-engine.sh` and `build-dmg.sh` already enforce this for macOS.
- [ ] Release notes say exactly what is and isn't verified (signing, notarization, devices tested).

## 2. macOS DMG (Apple silicon, macOS 14+)
- [ ] Built with `CONFIG=production REBUILD_ENGINE=1 macos/scripts/build-app.sh` and
      `macos/scripts/build-dmg.sh` on the release commit; all build checks pass.
- [ ] Launch test of the DMG copy with no developer services running (engine starts, scans,
      quits cleanly).
- [ ] **For a public release: Developer ID signing + Apple notarization + stapling** (needs the paid
      Apple Developer Program). Until then it is a *preview* signed with a local certificate, which
      Gatekeeper rejects — the release notes must say so and link the checksum instructions.
- [ ] Owner approves the file by SHA-256.

## 3. Android APK / AAB (Android 7.0+)
- [ ] Physical-device test on at least two Android versions (share, paste, link, dark mode).
- [ ] **Release signing** with a private upload key (kept outside the repository and CI logs; GitHub
      encrypted secret in a protected environment only after owner approval). Until then the APK is a
      debug *test build*, labelled as such.
- [ ] `aapt dump permissions` shows no network permission.
- [ ] Owner approves the file by SHA-256. Google Play: separate listing, data-safety form, review.

## 4. Publish (owner only)
- [ ] Tag `vX.Y.Z` on the release commit; create the GitHub Release (pre-release while unsigned).
- [ ] Attach the approved files and a `SHA256SUMS.txt`; re-download each file from GitHub and verify
      its checksum.
- [ ] Update `docs/site/releases.json` with the version, date, asset URLs and checksums; deploy the
      downloads page (manual Pages workflow).

Windows, Linux desktop and iOS have no distributable yet; they stay "Planned" on the downloads page.
