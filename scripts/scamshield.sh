#!/usr/bin/env bash
# One command to run ScamShield on this Mac (Phase 6).
#   scripts/scamshield.sh start     start the local services, then open the installed app
#   scripts/scamshield.sh stop      quit the app, then stop the local services
#   scripts/scamshield.sh restart
#   scripts/scamshield.sh status
# The app is single-instance: opening it again just shows its menu.
set -euo pipefail
cd "$(dirname "$0")/.."
BUNDLE_ID="dev.scamshield.mac"
APP="${SCAMSHIELD_APP:-$HOME/Applications/ScamShield.app}"
[[ -d "$APP" ]] || APP="$PWD/macos/build/ScamShield.app"

app_running() { pgrep -f "ScamShield.app/Contents/MacOS/ScamShield" >/dev/null; }

case "${1:-status}" in
  start)
    scripts/local-stack.sh start
    [[ -d "$APP" ]] || { echo "ScamShield.app not found — run scripts/install.sh"; exit 1; }
    open "$APP"
    echo "App        : opened $APP (menu-bar shield)"
    ;;
  stop)
    if app_running; then
      osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
      for _ in $(seq 1 20); do app_running || break; sleep 0.25; done
      echo "App        : quit"
    fi
    scripts/local-stack.sh stop
    ;;
  restart) "$0" stop; "$0" start ;;
  status)
    app_running && echo "App        : running" || echo "App        : not running"
    scripts/local-stack.sh status
    ;;
  *) echo "usage: $0 start|stop|restart|status"; exit 2 ;;
esac
