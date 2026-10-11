#!/usr/bin/env bash
# Uninstall ScamShield from this Mac (Phase 6).
#
#   scripts/uninstall.sh                       remove the APP only (quits it, stops services)
#   scripts/uninstall.sh --delete-user-data    ALSO delete your ScamShield data — asks you to type DELETE
#   scripts/uninstall.sh --reset-permissions   also forget the Screen Recording permission
#
# App files:  ~/Applications/ScamShield.app (and the installer's one-step backup)
# User data (kept unless --delete-user-data):
#   ~/Library/Application Support/ScamShield/history.json, reports.json   (scan history, your reports)
#   ~/Library/Application Support/ScamShield/server/                       (local PostgreSQL database)
#   macOS preferences domain dev.scamshield.mac                            (settings)
# Never touched: the repository (source, .env, ML models).
set -euo pipefail
cd "$(dirname "$0")/.."
BUNDLE_ID="dev.scamshield.mac"
TARGET="${INSTALL_DIR:-$HOME/Applications}/ScamShield.app"
DATA="$HOME/Library/Application Support/ScamShield"
DELETE_DATA=0; RESET_PERMS=0
for a in "$@"; do
  case "$a" in
    --delete-user-data) DELETE_DATA=1 ;;
    --reset-permissions) RESET_PERMS=1 ;;
    *) echo "unknown option $a"; exit 2 ;;
  esac
done

scripts/scamshield.sh stop || true

if [[ -d "$TARGET" ]]; then
  id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$TARGET/Contents/Info.plist" 2>/dev/null || true)"
  [[ "$id" == "$BUNDLE_ID" ]] || { echo "$TARGET is not ScamShield ($id) — not removing it"; exit 1; }
  rm -rf "$TARGET"
  echo "Removed $TARGET"
fi
rm -rf .scamshield-run/app-backup && echo "Removed the installer's app backup"

if [[ "$RESET_PERMS" == 1 ]]; then
  tccutil reset ScreenCapture "$BUNDLE_ID" && echo "Screen Recording permission reset"
fi

if [[ "$DELETE_DATA" == 1 ]]; then
  echo
  echo "This will PERMANENTLY delete:"
  echo "  $DATA   (history, reports, local database)"
  echo "  preferences domain $BUNDLE_ID"
  if [[ -t 0 ]]; then
    read -r -p "Type DELETE to confirm: " answer
  else
    answer="${SCAMSHIELD_CONFIRM_DELETE:-}"
  fi
  if [[ "$answer" == "DELETE" ]]; then
    rm -rf "$DATA"
    # `defaults` always talks to the REAL user's preferences daemon, even when HOME is overridden
    # (a sandboxed test once wiped real settings this way). Only use it for the real home folder.
    REAL_HOME="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
    if [[ "$HOME" == "$REAL_HOME" ]]; then
      defaults delete "$BUNDLE_ID" >/dev/null 2>&1 || true
    else
      rm -f "$HOME/Library/Preferences/$BUNDLE_ID.plist"
    fi
    echo "User data deleted."
  else
    echo "Not confirmed — your data was kept."
  fi
else
  echo "Your data was kept: $DATA (use --delete-user-data to remove it)."
fi
