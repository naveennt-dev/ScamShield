#!/usr/bin/env bash
# Builds macos/build/ScamShield-<version>.dmg from the production app (drag-to-Applications).
# The DMG is signed with the same identity as the app. It is NOT notarized: that needs a paid Apple
# Developer Program account (Developer ID + notarytool). Without it, other Macs show the
# "unidentified developer" step — see "Read me first.txt" in the DMG.
set -euo pipefail
cd "$(dirname "$0")/.."
APP="build/ScamShield.app"
[[ -d "$APP/Contents/Resources/engine" && "${REBUILD:-0}" != 1 ]] || CONFIG=production scripts/build-app.sh
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
DMG="build/ScamShield-${VERSION}.dmg"
STAGE="$(mktemp -d)"; MNT="$(mktemp -d)"
cleanup() { hdiutil detach "$MNT" -quiet 2>/dev/null || true; rm -rf "${STAGE:?}" "${MNT:?}"; }
trap cleanup EXIT

echo "▸ staging"
ditto "$APP" "$STAGE/ScamShield.app"
ln -s /Applications "$STAGE/Applications"
cat > "$STAGE/Read me first.txt" <<TXT
ScamShield ${VERSION} for macOS (Apple silicon)

Install: drag ScamShield into Applications, then open it from Applications.

First open: this build is not notarized by Apple yet. If macOS says it "cannot verify the
developer", open System Settings → Privacy & Security, find ScamShield and click "Open Anyway".
Only do this for a copy you downloaded from the official ScamShield release page and whose
SHA-256 matches the published checksum.

What runs on your Mac: ScamShield's analysis engine starts and stops with the app. Screen and
region scans need the Screen Recording permission, which macOS asks for the first time you scan.
Scans are analysed on this Mac. The optional AI second opinion sends only masked text (or, for
links, just the website address and findings) — you choose it on first launch and can turn it off
in Settings. Screenshots are never saved or sent.

Uninstall: quit ScamShield and move it to the Bin. Your history stays in
~/Library/Application Support/ScamShield until you delete that folder.
TXT

echo "▸ creating $DMG"
rm -f "$DMG"
hdiutil create -quiet -volname "ScamShield ${VERSION}" -srcfolder "$STAGE" -ov -format UDZO -imagekey zlib-level=9 "$DMG"
IDENTITY="${SCAMSHIELD_SIGN_IDENTITY:-}"
if [[ -z "$IDENTITY" ]] && security find-identity -p codesigning 2>/dev/null | grep -q '"ScamShield Local Signing"'; then IDENTITY="ScamShield Local Signing"; fi
[[ -n "$IDENTITY" ]] && codesign --force --sign "$IDENTITY" --timestamp=none "$DMG"

echo "▸ verifying"
hdiutil verify -quiet "$DMG" && echo "  ✓ image checksum"
hdiutil attach -quiet -readonly -nobrowse -mountpoint "$MNT" "$DMG"
codesign --verify --strict --deep "$MNT/ScamShield.app" && echo "  ✓ app signature (incl. embedded engine)"
python3 - "$MNT" <<'PY'
import os, re, sys
root = sys.argv[1]; vals = {}
for envf in ("../.env", "../db/.env"):
    if not os.path.exists(envf): continue
    for line in open(envf, encoding="utf-8"):
        m = re.match(r"^([A-Z0-9_]+)=(.*)$", line.strip())
        if m:
            v = m.group(2).strip().strip('"').strip("'")
            if len(v) >= 12 and re.search(r"KEY|SECRET|TOKEN|PASSWORD|_URL", m.group(1)) and not v.startswith(("http://127.0.0.1", "http://localhost")): vals[m.group(1)] = v.encode()
bad = []
for dp, dn, fn in os.walk(root):
    for f in fn:
        p = os.path.join(dp, f)
        if os.path.islink(p): continue
        if re.fullmatch(r"\.env(\..*)?", f) or f in ("history.json", "reports.json"): bad.append(("file", p)); continue
        try: d = open(p, "rb").read()
        except OSError: continue
        bad += [(k, p) for k, v in vals.items() if v in d]
if bad: print("✗ DMG CONTAINS SECRETS/USER DATA (values not shown):", bad[:10]); sys.exit(1)
print(f"  ✓ no .env, user data or any of {len(vals)} local secret values")
PY
hdiutil detach -quiet "$MNT"
( cd build && shasum -a 256 "$(basename "$DMG")" > "$(basename "$DMG").sha256" && cat "$(basename "$DMG").sha256" )
ls -lh "$DMG" | awk '{print "▸ size: "$5}'
