#!/usr/bin/env bash
# OPTIONAL: create a free, self-signed code-signing identity "ScamShield Local Signing" in your
# login keychain, so every rebuild of ScamShield is signed with the SAME certificate.
#
# Why: with ad-hoc signing (the default), each rebuild has a new code identity and macOS asks you
# to grant Screen Recording again. A stable self-signed certificate gives the app a stable
# designated requirement, which is what the permission is tied to.
#
# What it is NOT: an Apple Developer ID. The app is still only for this Mac (Gatekeeper would not
# accept it elsewhere; no notarization). Nothing is uploaded; no Apple account is needed.
#
# Undo: Keychain Access → login → My Certificates → delete "ScamShield Local Signing".
#   KEYCHAIN=/path/to/other.keychain-db macos/scripts/create-signing-identity.sh  (testing)
set -euo pipefail
NAME="ScamShield Local Signing"
KEYCHAIN="${KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"
if security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "\"$NAME\""; then
  echo "\"$NAME\" already exists in $KEYCHAIN"; exit 0
fi
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/cfg" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$TMP/cfg" -keyout "$TMP/key.pem" -out "$TMP/cert.pem" 2>/dev/null
PASS="$(openssl rand -hex 16)"
P12ARGS=(); openssl version | grep -q "OpenSSL 3" && P12ARGS=(-legacy)
openssl pkcs12 -export "${P12ARGS[@]}" -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -name "$NAME" -out "$TMP/id.p12" -passout "pass:$PASS"
# -T: allow codesign to use the key without a prompt each build.
security import "$TMP/id.p12" -k "$KEYCHAIN" -P "$PASS" -T /usr/bin/codesign >/dev/null
echo "Created \"$NAME\" in $KEYCHAIN."
echo "Rebuild with macos/scripts/build-app.sh (it uses this identity automatically), then grant Screen Recording once more — later rebuilds should keep it."
