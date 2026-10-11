#!/usr/bin/env bash
# Notarizes and staples a Developer ID–signed ScamShield DMG, then checks Gatekeeper.
#   macos/scripts/notarize.sh [path/to/ScamShield-<version>.dmg]
#
# One-time setup on the release Mac (needs the paid Apple Developer Program):
#   1. A "Developer ID Application" certificate in the login keychain.
#   2. Notary credentials stored in the keychain — never in files, the repository or CI logs:
#        xcrun notarytool store-credentials scamshield-notary --apple-id <apple-id> --team-id <TEAMID>
#      (prompts for an app-specific password created at appleid.apple.com).
# Build first with: SCAMSHIELD_SIGN_IDENTITY="Developer ID Application: <Name> (<TEAMID>)" \
#   CONFIG=production REBUILD_ENGINE=1 macos/scripts/build-app.sh && macos/scripts/build-dmg.sh
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' ScamShield/Info.plist)"
DMG="${1:-build/ScamShield-$VERSION.dmg}"
PROFILE="${SCAMSHIELD_NOTARY_PROFILE:-scamshield-notary}"
[[ -f "$DMG" ]] || { echo "✗ $DMG not found"; exit 1; }

# First "Authority=" line; awk reads to the end so codesign never gets SIGPIPE under pipefail.
authority() { codesign -dvv "$1" 2>&1 | awk -F= '/^Authority=/ && !seen {print $2; seen=1}'; }
MNT="$(mktemp -d)"; trap 'hdiutil detach -quiet "$MNT" 2>/dev/null || true; rmdir "$MNT" 2>/dev/null || true' EXIT
hdiutil attach -readonly -nobrowse -mountpoint "$MNT" "$DMG" >/dev/null
APP_AUTH="$(authority "$MNT/ScamShield.app")"; DMG_AUTH="$(authority "$DMG")"
hdiutil detach -quiet "$MNT"
for pair in "app:$APP_AUTH" "dmg:$DMG_AUTH"; do
  [[ "${pair#*:}" == "Developer ID Application:"* ]] || { echo "✗ ${pair%%:*} is signed by '${pair#*:}', not a Developer ID — cannot notarize"; exit 1; }
done
echo "▸ submitting $DMG to Apple's notary service (profile: $PROFILE)"
OUT="$(xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait --output-format json)"
STATUS="$(printf '%s' "$OUT" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))')"
ID="$(printf '%s' "$OUT" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))')"
if [[ "$STATUS" != "Accepted" ]]; then
  echo "✗ notarization $STATUS (submission $ID). Details: xcrun notarytool log $ID --keychain-profile $PROFILE"; exit 1
fi
echo "▸ stapling the ticket"
xcrun stapler staple "$DMG" && xcrun stapler validate "$DMG"
echo "▸ Gatekeeper assessment"
spctl -a -t open --context context:primary-signature -v "$DMG"
hdiutil attach -readonly -nobrowse -mountpoint "$MNT" "$DMG" >/dev/null
spctl -a -t exec -vv "$MNT/ScamShield.app"
shasum -a 256 "$DMG"
echo "✓ notarized, stapled and accepted by Gatekeeper"
