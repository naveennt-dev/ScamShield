#!/usr/bin/env bash
# Builds ScamShield.app (menu-bar utility) from the Swift package using only the Command Line Tools.
#   CONFIG=development|production (default development) — production hides sample-data previews.
#   Output: macos/build/ScamShield.app (signed ad-hoc, or with a stable local identity; personal use).
set -euo pipefail
cd "$(dirname "$0")/../ScamShield"

CONFIG="${CONFIG:-development}"
OUT="${OUT:-../build}"
APP="$OUT/ScamShield.app"

# Development builds include the self-test, scan evaluation and sample previews
# (SCAMSHIELD_DEVTOOLS); production builds contain none of it. Separate build folders keep the two
# configurations from mixing.
if [[ "$CONFIG" == "production" ]]; then
  unset SCAMSHIELD_DEVTOOLS; SCRATCH=".build"
else
  export SCAMSHIELD_DEVTOOLS=1; SCRATCH=".build-dev"
fi
echo "▸ swift build (release, $CONFIG)"
swift build -c release --scratch-path "$SCRATCH" --product ScamShield
swift build -c release --scratch-path "$SCRATCH" --product ScamShieldSnapshots
BIN_DIR="$(swift build -c release --scratch-path "$SCRATCH" --show-bin-path)"

echo "▸ assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/ScamShield" "$APP/Contents/MacOS/ScamShield"
cp Info.plist "$APP/Contents/Info.plist"

if [[ "$CONFIG" == "production" ]]; then
  /usr/libexec/PlistBuddy -c "Set :ScamShieldEnvironment production" "$APP/Contents/Info.plist"
fi
plutil -lint "$APP/Contents/Info.plist" >/dev/null

echo "▸ generating placeholder icon"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
"$BIN_DIR/ScamShieldSnapshots" "$TMP" --icon-only >/dev/null
ICONSET="$TMP/AppIcon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$TMP/AppIcon-1024.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2)); sips -z $d $d "$TMP/AppIcon-1024.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

# Signing: a stable identity (SCAMSHIELD_SIGN_IDENTITY, or "ScamShield Local Signing" created by
# macos/scripts/create-signing-identity.sh) keeps the Screen Recording permission across rebuilds;
# otherwise ad-hoc (macOS then asks for the permission again after each rebuild).
IDENTITY="${SCAMSHIELD_SIGN_IDENTITY:-}"
if [[ -z "$IDENTITY" ]] && security find-identity -p codesigning 2>/dev/null | grep -q '"ScamShield Local Signing"'; then
  IDENTITY="ScamShield Local Signing"
fi
if [[ -n "$IDENTITY" ]]; then
  echo "▸ code signing with \"$IDENTITY\" (stable identity)"
  codesign --force --sign "$IDENTITY" ${SCAMSHIELD_SIGN_KEYCHAIN:+--keychain "$SCAMSHIELD_SIGN_KEYCHAIN"} --options runtime --timestamp=none "$APP"
else
  echo "▸ ad-hoc code signing (Screen Recording must be re-granted after each rebuild)"
  codesign --force --sign - --options runtime --timestamp=none "$APP"
fi
codesign --verify --strict "$APP"

echo "✓ built $APP ($CONFIG)"
