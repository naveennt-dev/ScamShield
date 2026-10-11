#!/usr/bin/env bash
# Packages verified release assets into dist/release-v<version>/ — never uploads anything.
#   scripts/release/package-release.sh <version> [--android path/to/app-release.apk] [--aab path] [--macos path/to.dmg]
# Every asset must pass its gate; anything unverified is refused (no "preview" exception here):
#   Android: signed with a release key (not "Android Debug"), not debuggable, no network permission,
#            versionName == <version>.
#   macOS:   Developer ID signature, stapled notarization ticket, Gatekeeper accepts it, version == <version>.
# Output: renamed assets (the names the downloads page recognises), SHA256SUMS.txt, RELEASE_NOTES.md draft,
# and the exact `gh release create --draft` command for the owner to run after reviewing.
set -euo pipefail
cd "$(dirname "$0")/../.."
VERSION="${1:?usage: package-release.sh <version> [--android apk] [--aab aab] [--macos dmg]}"; shift
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "✗ version must be X.Y.Z"; exit 1; }
APK=""; AAB=""; DMG=""
while [[ $# -gt 0 ]]; do case "$1" in
  --android) APK="$2"; shift 2;; --aab) AAB="$2"; shift 2;; --macos) DMG="$2"; shift 2;;
  *) echo "✗ unknown option $1"; exit 1;; esac; done
[[ -n "$APK$AAB$DMG" ]] || { echo "✗ give at least one of --android, --aab, --macos"; exit 1; }

BT="$(ls -d "${ANDROID_HOME:-$HOME/Library/Android/sdk}"/build-tools/* 2>/dev/null | sort -V | tail -1)"
OUT="dist/release-v$VERSION"; rm -rf "$OUT"; mkdir -p "$OUT"
fail() { echo "✗ $*"; rm -rf "$OUT"; exit 1; }

if [[ -n "$APK" ]]; then
  [[ -f "$APK" && -n "$BT" ]] || fail "APK or Android build-tools not found"
  "$BT/apksigner" verify "$APK" >/dev/null 2>&1 || fail "APK signature does not verify"
  SIGNER="$("$BT/apksigner" verify --print-certs "$APK" | awk -F'DN: ' '/certificate DN/ && !s {print $2; s=1}')"
  [[ "$SIGNER" != *"CN=Android Debug"* ]] || fail "APK is signed with the Android DEBUG key — not a release"
  [[ "$("$BT/aapt" dump xmltree "$APK" AndroidManifest.xml | grep -c debuggable || true)" == 0 ]] || fail "APK is debuggable"
  ! "$BT/aapt" dump permissions "$APK" | grep -qE 'INTERNET|ACCESS_NETWORK_STATE' || fail "APK requests a network permission"
  "$BT/aapt" dump badging "$APK" | grep -q "versionName='$VERSION'" || fail "APK versionName is not $VERSION"
  cp "$APK" "$OUT/ScamShield-$VERSION-android.apk"; echo "✓ Android APK (signer: $SIGNER)"
fi
if [[ -n "$AAB" ]]; then
  [[ -f "$AAB" ]] || fail "AAB not found"
  jarsigner -verify "$AAB" 2>&1 | grep -q "jar verified" || fail "AAB signature does not verify"
  jarsigner -verify -verbose -certs "$AAB" 2>&1 | grep -q "CN=Android Debug" && fail "AAB is signed with the Android DEBUG key"
  cp "$AAB" "$OUT/ScamShield-$VERSION-android.aab"; echo "✓ Android App Bundle (for Google Play)"
fi
if [[ -n "$DMG" ]]; then
  [[ -f "$DMG" ]] || fail "DMG not found"
  xcrun stapler validate "$DMG" >/dev/null 2>&1 || fail "DMG has no stapled notarization ticket (run macos/scripts/notarize.sh)"
  spctl -a -t open --context context:primary-signature "$DMG" 2>/dev/null || fail "Gatekeeper rejects the DMG"
  MNT="$(mktemp -d)"; hdiutil attach -readonly -nobrowse -mountpoint "$MNT" "$DMG" >/dev/null
  AUTH="$(codesign -dvv "$MNT/ScamShield.app" 2>&1 | awk -F= '/^Authority=/ && !s {print $2; s=1}')"
  VER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$MNT/ScamShield.app/Contents/Info.plist")"
  GK=0; spctl -a -t exec "$MNT/ScamShield.app" 2>/dev/null || GK=1
  hdiutil detach -quiet "$MNT"; rmdir "$MNT"
  [[ "$AUTH" == "Developer ID Application:"* ]] || fail "app is signed by '$AUTH', not a Developer ID"
  [[ "$GK" == 0 ]] || fail "Gatekeeper rejects the app"
  [[ "$VER" == "$VERSION" ]] || fail "app version is $VER, not $VERSION"
  cp "$DMG" "$OUT/ScamShield-$VERSION-macos-arm64.dmg"; echo "✓ macOS DMG (notarized, Developer ID)"
fi

( cd "$OUT" && shasum -a 256 ScamShield-* > SHA256SUMS.txt )
{
  echo "# ScamShield $VERSION"
  echo
  echo "<!-- Edit before publishing: summary, what's new (from CHANGELOG.md), known limitations. -->"
  echo
  echo "## Downloads"
  [[ -f "$OUT/ScamShield-$VERSION-macos-arm64.dmg" ]] && echo "- **macOS** (Apple silicon, macOS 14+): \`ScamShield-$VERSION-macos-arm64.dmg\` — Developer ID signed and notarized."
  [[ -f "$OUT/ScamShield-$VERSION-android.apk" ]] && echo "- **Android** (7.0+): \`ScamShield-$VERSION-android.apk\` — release-signed; install from this page only."
  [[ -f "$OUT/ScamShield-$VERSION-android.aab" ]] && echo "- Android App Bundle (Google Play upload): \`ScamShield-$VERSION-android.aab\`."
  echo
  echo "## Verify"
  echo '```'
  cat "$OUT/SHA256SUMS.txt"
  echo '```'
  echo "Check with \`shasum -a 256 <file>\` (macOS/Linux) or \`Get-FileHash <file>\` (Windows)."
  echo
  echo "No detector can guarantee that a message or link is safe."
} > "$OUT/RELEASE_NOTES.md"
echo; cat "$OUT/SHA256SUMS.txt"
echo
echo "Review $OUT/RELEASE_NOTES.md, then (owner only) create a DRAFT release and publish it on GitHub after checking it:"
echo "  gh release create v$VERSION --draft --title \"ScamShield $VERSION\" --notes-file $OUT/RELEASE_NOTES.md $OUT/ScamShield-$VERSION-* $OUT/SHA256SUMS.txt"
