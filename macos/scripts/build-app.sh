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
# Record the real SDK in the binary (see Package.swift: decides the macOS 26+ system design).
SCAMSHIELD_SDK_VERSION="$(xcrun --sdk macosx --show-sdk-version)"; export SCAMSHIELD_SDK_VERSION
echo "▸ swift build (release, $CONFIG, SDK $SCAMSHIELD_SDK_VERSION)"
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

# On-device engine (production builds): the app starts it itself — no Terminal, no developer tools.
if [[ "$CONFIG" == "production" && "${SKIP_ENGINE:-0}" != 1 ]]; then
  if [[ ! -x ../build/engine/node || "${REBUILD_ENGINE:-0}" == 1 ]]; then
    echo "▸ building the engine"
    ../../scripts/build-engine.sh   # writes macos/build/engine
  fi
  echo "▸ embedding the engine"
  mkdir -p "$APP/Contents/Resources/engine"
  rsync -a --delete ../build/engine/ "$APP/Contents/Resources/engine/"
fi

# Signing: a stable identity (SCAMSHIELD_SIGN_IDENTITY, or "ScamShield Local Signing" created by
# macos/scripts/create-signing-identity.sh) keeps the Screen Recording permission across rebuilds;
# otherwise ad-hoc (macOS then asks for the permission again after each rebuild).
IDENTITY="${SCAMSHIELD_SIGN_IDENTITY:-}"
if [[ -z "$IDENTITY" ]] && security find-identity -p codesigning 2>/dev/null | grep -q '"ScamShield Local Signing"'; then
  IDENTITY="ScamShield Local Signing"
fi
SIGN_ID="${IDENTITY:--}"
# Nested code first (inside-out): every Mach-O file of the embedded engine, with the hardened
# runtime; the Node.js runtime additionally gets Engine.entitlements (V8 JIT only).
if [[ -d "$APP/Contents/Resources/engine" ]]; then
  echo "▸ signing the embedded engine's native code"
  # Without an Apple Team ID (local/ad-hoc identity) library validation would block the engine's own
  # native modules; only Developer ID builds keep it on.
  ENGINE_ENT=Engine-LocalSigning.entitlements
  [[ "$SIGN_ID" == "Developer ID Application:"* ]] && ENGINE_ENT=Engine.entitlements
  echo "  engine entitlements: $ENGINE_ENT"
  while IFS= read -r f; do
    if file -b "$f" | grep -q "Mach-O"; then
      ENT=(); [[ "$f" == "$APP/Contents/Resources/engine/node" ]] && ENT=(--entitlements "$ENGINE_ENT")
      codesign --force --sign "$SIGN_ID" ${SCAMSHIELD_SIGN_KEYCHAIN:+--keychain "$SCAMSHIELD_SIGN_KEYCHAIN"} --options runtime --timestamp=none ${ENT[@]+"${ENT[@]}"} "$f"
    fi
  done < <(find "$APP/Contents/Resources/engine" -type f \( -perm -u+x -o -name "*.node" -o -name "*.dylib" \))
fi
if [[ -n "$IDENTITY" ]]; then
  echo "▸ code signing with \"$IDENTITY\" (stable identity)"
  codesign --force --sign "$IDENTITY" ${SCAMSHIELD_SIGN_KEYCHAIN:+--keychain "$SCAMSHIELD_SIGN_KEYCHAIN"} --options runtime --timestamp=none "$APP"
else
  echo "▸ ad-hoc code signing (Screen Recording must be re-granted after each rebuild)"
  codesign --force --sign - --options runtime --timestamp=none "$APP"
fi
codesign --verify --strict "$APP"
BUILT_SDK="$(otool -l "$APP/Contents/MacOS/ScamShield" | awk '/LC_BUILD_VERSION/{f=1} f&&/ sdk /{print $2; exit}')"
[[ "$BUILT_SDK" == "$SCAMSHIELD_SDK_VERSION" ]] || { echo "✗ app records SDK $BUILT_SDK, expected $SCAMSHIELD_SDK_VERSION"; exit 1; }
echo "  ✓ linked against macOS SDK $BUILT_SDK (minimum macOS $(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$APP/Contents/Info.plist"))"

# The engine smoke test runs before signing; prove the SIGNED runtime can still load every native
# module (library validation failures only appear after signing).
if [[ -d "$APP/Contents/Resources/engine" ]]; then
  echo "▸ loading native modules with the signed runtime"
  while IFS= read -r m; do
    "$APP/Contents/Resources/engine/node" -e 'process.dlopen({exports:{}}, process.argv[1])' "$m" \
      || { echo "✗ signed runtime cannot load ${m#"$APP/"}"; exit 1; }
  done < <(find "$(cd "$APP" && pwd -P)/Contents/Resources/engine" -name "*.node")
  echo "  ✓ all native modules load"
fi

echo "✓ built $APP ($CONFIG)"
