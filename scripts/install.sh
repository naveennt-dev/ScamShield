#!/usr/bin/env bash
# Personal installation of ScamShield on this Mac (Phase 6).
#
#   scripts/install.sh                 build everything and install to ~/Applications/ScamShield.app
#   scripts/install.sh --skip-build    install the already-built macos/build/ScamShield.app
#   INSTALL_DIR=/Applications scripts/install.sh   (needs write access there)
#
# What it does:
#   1. checks prerequisites and prints the exact fix for anything missing;
#   2. builds the web API (npm run build) and the Mac app (CONFIG=production);
#   3. replaces ONLY a previous ScamShield.app (bundle id dev.scamshield.mac) — anything else at
#      the target path is left alone and the install stops; the previous version is kept as a
#      one-step backup in $BACKUP_DIR;
#   4. verifies no .env file or API key is inside the app bundle.
# It never touches your data (~/Library/Application Support/ScamShield: history, reports, database),
# your settings, the repository's .env, or macOS permissions.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
INSTALL_DIR="${INSTALL_DIR:-$HOME/Applications}"
TARGET="$INSTALL_DIR/ScamShield.app"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/.scamshield-run/app-backup}"
BUNDLE_ID="dev.scamshield.mac"
SKIP_BUILD=0
[[ "${1:-}" == "--skip-build" ]] && SKIP_BUILD=1

ok() { echo "  ✓ $*"; }
fail() { echo "  ✗ $*" >&2; MISSING=1; }
MISSING=0

echo "▸ Checking prerequisites"
[[ "$(uname)" == "Darwin" ]] || { echo "macOS only"; exit 1; }
MAJOR="$(sw_vers -productVersion | cut -d. -f1)"; [[ "$MAJOR" -ge 14 ]] && ok "macOS $(sw_vers -productVersion)" || fail "macOS 14 or newer required"
xcode-select -p >/dev/null 2>&1 && command -v swift >/dev/null && ok "Swift $(swift --version 2>/dev/null | head -1 | sed -E 's/.*version ([0-9.]+).*/\1/')" || fail "Swift toolchain missing → xcode-select --install"
command -v node >/dev/null && [[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]] && ok "Node $(node -v)" || fail "Node.js 20+ missing → brew install node (or fnm/nvm)"
command -v python3 >/dev/null && ok "Python $(python3 -V | cut -d' ' -f2)" || fail "python3 missing → brew install python"
[[ -x ml/.venv/bin/python ]] && ok "ML Python environment (ml/.venv)" || fail "ML environment missing → python3 -m venv ml/.venv && ml/.venv/bin/pip install -r ml/requirements.txt"
[[ -f ml/models/model_manifest.json && -f ml/models/scam_classifier.joblib ]] && ok "trained ML model" || fail "ML model missing → npm run ml:fetch-data && npm run ml:train"
{ [[ -x /opt/homebrew/opt/postgresql@17/bin/pg_ctl ]] || command -v pg_ctl >/dev/null; } && ok "PostgreSQL" || echo "  ! PostgreSQL not found (optional for Mac scanning; needed for web accounts/history) → brew install postgresql@17"
command -v redis-server >/dev/null && ok "Redis" || echo "  ! Redis not found (optional; without it rate limits are in-memory) → brew install redis"
[[ -f .env ]] && ok ".env present (not read or changed by the installer)" || echo "  ! no .env — copy .env.example to .env and edit it (local-only works with the defaults)"
[[ "$MISSING" == 0 ]] || { echo "Fix the items marked ✗ and run again."; exit 1; }

WAS_RUNNING=0
if [[ "$SKIP_BUILD" == 0 ]]; then
  # The API serves files from .next; rebuilding underneath a running server breaks it.
  if curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:${PORT:-3000}/api/v1/health"; then
    WAS_RUNNING=1
    # If any later step fails, bring the services back instead of leaving them stopped.
    trap 'echo "▸ install failed — restarting the local services"; scripts/local-stack.sh start >/dev/null 2>&1 || true' ERR
    echo "▸ Stopping the running local services for the rebuild (restarted afterwards)"
    scripts/local-stack.sh stop | sed 's/^/  /'
  fi
  echo "▸ Building the local API"
  [[ -d node_modules ]] || npm install --no-fund --no-audit
  npx prisma generate >/dev/null
  npm run build >/dev/null
  ok "web API built (.next)"
  echo "▸ Building the Mac app"
  CONFIG=production macos/scripts/build-app.sh | sed 's/^/  /'
fi
SRC="$ROOT/macos/build/ScamShield.app"
[[ -d "$SRC" ]] || { echo "No built app at $SRC (run without --skip-build)"; exit 1; }
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$SRC/Contents/Info.plist")" == "$BUNDLE_ID" ]] || { echo "Built bundle has an unexpected identifier"; exit 1; }

echo "▸ Checking the bundle contains no secrets"
if find "$SRC" -name '.env*' | grep -q . || grep -rlaE 'sk-or-v1-[0-9a-f]{20,}|OPENROUTER_API_KEY=' "$SRC" >/dev/null 2>&1; then
  echo "  ✗ the app bundle contains an .env file or an API key — refusing to install"; exit 1
fi
ok "no .env file or API key in the bundle"

echo "▸ Installing to $TARGET"
mkdir -p "$INSTALL_DIR"
if [[ -e "$TARGET" ]]; then
  existing="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$TARGET/Contents/Info.plist" 2>/dev/null || true)"
  [[ "$existing" == "$BUNDLE_ID" ]] || { echo "  ✗ $TARGET exists but is not ScamShield ($existing) — not touching it"; exit 1; }
  if pgrep -f "$TARGET/Contents/MacOS/ScamShield" >/dev/null; then
    osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do pgrep -f "$TARGET/Contents/MacOS/ScamShield" >/dev/null || break; sleep 0.25; done
    pkill -f "$TARGET/Contents/MacOS/ScamShield" 2>/dev/null || true
    ok "quit the running copy"
  fi
  mkdir -p "$BACKUP_DIR"
  rm -rf "$BACKUP_DIR/ScamShield.app"
  mv "$TARGET" "$BACKUP_DIR/ScamShield.app"
  ok "previous version kept at $BACKUP_DIR/ScamShield.app"
fi
ditto "$SRC" "$TARGET"
codesign --verify --strict "$TARGET" && ok "installed and signature verified ($(codesign -dv "$TARGET" 2>&1 | grep -E '^Signature|^Authority' | head -1))"

if [[ "$WAS_RUNNING" == 1 ]]; then
  echo "▸ Restarting the local services"
  scripts/local-stack.sh start | sed 's/^/  /'
fi

cat <<EOF

Done. Next:
  scripts/scamshield.sh start        # start the local services and open ScamShield
  Grant Screen Recording when asked:  System Settings → Privacy & Security → Screen & System Audio Recording
Your history, reports, database and settings were not touched.
EOF
