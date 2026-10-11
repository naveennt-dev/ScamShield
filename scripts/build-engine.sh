#!/usr/bin/env bash
# Builds the self-contained "ScamShield Engine" bundled inside the desktop app:
#   macos/build/engine/node            official Node.js runtime (signature + checksum verified)
#   macos/build/engine/app/            Next.js standalone server (API used by the app + extension)
# No PostgreSQL, Redis, Python or .env is needed at run time: the engine runs on-device with the
# embedded ML model, in-memory rate limits and settings passed by the app.
#
# Security gates (the build FAILS on any of them):
#   - Node.js tarball: SHASUMS256.txt must be GPG-signed by an active Node.js release key, and the
#     tarball's SHA-256 must match it
#   - no .env* file anywhere in the output
#   - none of the secret values in this machine's .env may appear in any output file
set -euo pipefail
cd "$(dirname "$0")/.."
NODE_VERSION="${NODE_VERSION:-22.23.1}"
ARCH="$(uname -m)"; [[ "$ARCH" == "x86_64" ]] && ARCH="x64"
OUT="${OUT:-macos/build/engine}"
CACHE="${HOME}/Library/Caches/ScamShield-build/node-v${NODE_VERSION}-darwin-${ARCH}"
TARBALL="node-v${NODE_VERSION}-darwin-${ARCH}.tar.gz"
BASE="https://nodejs.org/dist/v${NODE_VERSION}"
fetch() { curl -fsSL --proto '=https' --tlsv1.2 --retry 2 -o "$2" "$1"; }

echo "▸ Node.js runtime v${NODE_VERSION} (${ARCH})"
mkdir -p "$CACHE"
if [[ ! -f "$CACHE/verified" ]]; then
  fetch "$BASE/SHASUMS256.txt" "$CACHE/SHASUMS256.txt"
  fetch "$BASE/SHASUMS256.txt.sig" "$CACHE/SHASUMS256.txt.sig"
  fetch "$BASE/$TARBALL" "$CACHE/$TARBALL"
  fetch "https://raw.githubusercontent.com/nodejs/release-keys/main/gpg-only-active-keys/pubring.kbx" "$CACHE/release-keys.kbx"
  gpgv --keyring "$CACHE/release-keys.kbx" "$CACHE/SHASUMS256.txt.sig" "$CACHE/SHASUMS256.txt" 2>"$CACHE/gpgv.log" \
    || { cat "$CACHE/gpgv.log"; echo "✗ SHASUMS256.txt signature did not verify — refusing to use this runtime"; exit 1; }
  ( cd "$CACHE" && grep " ${TARBALL}\$" SHASUMS256.txt | shasum -a 256 -c - ) || { echo "✗ tarball checksum mismatch"; exit 1; }
  tar -xzf "$CACHE/$TARBALL" -C "$CACHE" "node-v${NODE_VERSION}-darwin-${ARCH}/bin/node" "node-v${NODE_VERSION}-darwin-${ARCH}/LICENSE"
  touch "$CACHE/verified"
  echo "  ✓ signature by a Node.js release key and SHA-256 verified"
else
  echo "  ✓ using cached, previously verified runtime"
fi

echo "▸ Next.js standalone build"
SCAMSHIELD_STANDALONE=1 npm run -s build >/dev/null
rm -f .next/standalone/.env .next/standalone/.env.*   # Next.js copies .env into standalone output

echo "▸ Assembling $OUT"
rm -rf "${OUT:?}"
mkdir -p "$OUT/app"
rsync -a .next/standalone/ "$OUT/app/"
mkdir -p "$OUT/app/.next/static" && rsync -a .next/static/ "$OUT/app/.next/static/"
[[ -d public ]] && rsync -a public/ "$OUT/app/public/"
# The isolated-browser inspector is not bundled in the desktop app (off by default; needs Chromium).
rm -rf "$OUT/app/src/lib/linkscan/dynamic"
install -m 0755 "$CACHE/node-v${NODE_VERSION}-darwin-${ARCH}/bin/node" "$OUT/node"
install -m 0644 "$CACHE/node-v${NODE_VERSION}-darwin-${ARCH}/LICENSE" "$OUT/NODE-LICENSE"
find "$OUT" -name ".env*" -print -delete | sed 's/^/  removed /'

echo "▸ Secret gate"
python3 - "$OUT" <<'PY'
import os, re, sys
out = sys.argv[1]
vals = {}
for envf in (".env", "db/.env"):
    if not os.path.exists(envf): continue
    for line in open(envf, encoding="utf-8"):
        m = re.match(r"^([A-Z0-9_]+)=(.*)$", line.strip())
        if not m: continue
        v = m.group(2).strip().strip('"').strip("'")
        if len(v) >= 12 and re.search(r"KEY|SECRET|TOKEN|PASSWORD|_URL", m.group(1)) and not v.startswith(("http://127.0.0.1", "http://localhost")):
            vals[m.group(1)] = v.encode()
bad = []
for dp, dn, fn in os.walk(out):
    for f in fn:
        p = os.path.join(dp, f)
        if re.fullmatch(r"\.env(\..*)?", f): bad.append(("env-file", p)); continue
        try: data = open(p, "rb").read()
        except OSError: continue
        bad += [(k, p) for k, v in vals.items() if v in data]
if bad:
    print("✗ SECRET GATE FAILED (values not shown):"); [print("  ", k, p) for k, p in bad[:20]]; sys.exit(1)
print(f"  ✓ no .env files; none of {len(vals)} local secret values present")
PY

echo "▸ Smoke test (no .env, no database, no Redis, no Python)"
SMOKE_LOG="$(cd "$OUT/.." && pwd)/engine-smoke.log"
PORT_TEST=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
( cd "$OUT/app" && env -i PATH=/usr/bin:/bin HOME="$HOME" NODE_ENV=production HOSTNAME=127.0.0.1 PORT=$PORT_TEST \
    SCAMSHIELD_EDITION=desktop ML_BACKEND=embedded LOCAL_CLIENT_RATE_TIER=true LLM_ENABLED=false BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
    BETTER_AUTH_URL="http://127.0.0.1:$PORT_TEST" "../node" server.js >"$SMOKE_LOG" 2>&1 ) &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -fs "http://127.0.0.1:$PORT_TEST/api/v1/health" >/dev/null 2>&1 && break; sleep 0.5; done
python3 - "$PORT_TEST" <<'PY'
import json, sys, urllib.request
port = sys.argv[1]
def post(path, body):
    r = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=20))["data"]
h = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/api/v1/health", timeout=10))["data"]
m = post("/api/v1/analyze/message", {"message": "Dear customer your SBI KYC expired, share the OTP sent to your phone at sbi-kyc-update.xyz", "source": "screen"})
g = post("/api/v1/analyze/message", {"message": "Are we still meeting for lunch tomorrow at 1?", "source": "screen"})
l = post("/api/v1/analyze/link", {"url": "https://paypa1-secure-login.top/verify", "analysisMode": "local"})
ok = h["status"] == "ok" and h.get("edition") == "desktop" and m["riskLevel"] in ("high", "critical") and g["riskLevel"] == "safe" and g["assessment"]["status"] == "complete" and l["verdict"] == "high_risk" and h["checks"].get("ml") == "ok"
print(f"  health={h['status']} ml={h['checks'].get('ml')} scam={m['riskLevel']} genuine={g['riskLevel']} link={l['verdict']}")
sys.exit(0 if ok else 1)
PY
echo "  ✓ engine works stand-alone"
du -sh "$OUT" | awk '{print "▸ engine size: "$1}'
