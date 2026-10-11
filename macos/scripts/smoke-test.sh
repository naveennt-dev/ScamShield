#!/usr/bin/env bash
# Launches the BUILT app through LaunchServices in self-test mode. The app installs its menu-bar
# item, opens the popover, runs every scanner state, the hotkey handler, Esc, Settings, snapshots
# its OWN windows, then quits through NSApp.terminate (the Quit menu path).
# Requires a logged-in GUI session. Nothing on screen is captured; no permissions are requested.
#   EXPECT_BACKEND=1 also checks the app can reach the local backend (start it first).
set -euo pipefail
cd "$(dirname "$0")/.."
# The self-test is a developer tool: it exists only in development builds (SCAMSHIELD_DEVTOOLS).
APP="build/devtools/ScamShield.app"
if [[ ! -d "$APP" || "${REBUILD:-0}" == 1 ]]; then
  echo "Building the development app (self-test included) into ${APP}…"
  OUT=../build/devtools CONFIG=development scripts/build-app.sh >/dev/null
fi
OUT="$(pwd)/${1:-build/self-test}"
[[ -d "$APP" ]] || { echo "Development build failed: run OUT=../build/devtools CONFIG=development macos/scripts/build-app.sh"; exit 1; }
rm -rf "$OUT"; mkdir -p "$OUT"

open -n "$APP" --env "SCAMSHIELD_SELFTEST_EXPECT_BACKEND=${EXPECT_BACKEND:-0}" --args --self-test "$OUT"

# While it runs: confirm macOS treats it as a menu-bar-only (UIElement) app — no Dock icon.
# (polled: a freshly built app can take several seconds to register with LaunchServices)
TYPE=""
for _ in $(seq 1 15); do
  sleep 1
  # Look the test copy up by its own bundle path: the installed app shares the bundle id.
  TYPE="$(lsappinfo list 2>/dev/null | grep -A2 "bundle path=\"$(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")\"" | grep -o 'type="[A-Za-z]*"' | head -1 || true)"
  [[ "$TYPE" == *UIElement* ]] && break
done
echo "LaunchServices: $TYPE"

for _ in $(seq 1 240); do   # the self-test runs ~2 min (incl. a 25-scan soak)
  [[ -f "$OUT/report.json" ]] && break
  sleep 1
done
sleep 2
# The self-test's isolated settings suite is throw-away.
find "$HOME/Library/Preferences" -maxdepth 1 -type f -E -regex '.*/dev\.scamshield\.selftest\.[0-9A-F-]{36}\.plist' -delete 2>/dev/null || true
[[ -f "$OUT/report.json" ]] || { echo "FAIL: no report produced"; exit 1; }

python3 - "$OUT" "$TYPE" <<'PY'
import json, os, sys
out, app_type = sys.argv[1], sys.argv[2]
r = json.load(open(os.path.join(out, "report.json")))
for c in r["checks"]:
    label = {"pass": "PASS ", "fail": "FAIL ", "skipped": "SKIP "}.get(c.get("status"), "PASS " if c["passed"] else "FAIL ")
    print(label + c["name"] + (f"  [{c['detail']}]" if c["detail"] else ""))
extra_ok = True
ui_element = "UIElement" in app_type
print(("PASS " if ui_element else "FAIL ") + "menu-bar-only app (LSUIElement, no Dock icon)")
quit_ok = os.path.exists(os.path.join(out, "terminated.txt"))
user_input = r.get("userInput", [])
print(f"INFO real user input reaching ScamShield during the run: {len(user_input)}" + (f"  {user_input[:3]}" if user_input else ""))
print(("PASS " if quit_ok else "FAIL ") + "quit via NSApp.terminate shuts down cleanly")
ok = r["passed"] and ui_element and quit_ok
print(f"SMOKE TEST {'PASSED' if ok else 'FAILED'} ({r['total'] + 2} checks, {r.get('skipped', 0)} skipped)")
sys.exit(0 if ok else 1)
PY
