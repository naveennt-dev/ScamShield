#!/usr/bin/env bash
# Unit tests (Swift Testing) for ScamShieldCore.
#
# Toolchain workaround: with the Command Line Tools' default `swiftbuild` backend, test builds
# intermittently fail with "plugin for module 'TestingMacros' not found" (the macro plugin flag is
# dropped from some compile commands). We pass the toolchain's TestingMacros plugin explicitly,
# which makes the build deterministic. Harmless when using Xcode's toolchain.
set -euo pipefail
cd "$(dirname "$0")/../ScamShield"

TOOLCHAIN_BIN="$(dirname "$(xcrun -f swift)")"
PLUGIN="$TOOLCHAIN_BIN/../lib/swift/host/plugins/testing/libTestingMacros.dylib"
EXTRA=()
if [[ -f "$PLUGIN" ]]; then
  EXTRA=(-Xswiftc -load-plugin-library -Xswiftc "$PLUGIN")
fi
# macOS writes test-suite preference files shortly AFTER the run exits, so also clean up the
# previous run's leftovers before starting.
find "$HOME/Library/Preferences" -maxdepth 1 -type f -E -regex '.*/(scamshield\.tests\.|scamshield\.history\.tests\.|ss\.cap\.|consent\.test\.|outbox\.test\.)[0-9A-F-]{36}\.plist' -delete 2>/dev/null || true
status=0
swift test "${EXTRA[@]}" "$@" || status=$?

# The app target isn't built by the tests: compile both configurations so code behind
# SCAMSHIELD_DEVTOOLS (self-test, scan evaluation, previews) can't silently break.
if [[ "$status" == 0 && "${SKIP_APP_BUILDS:-0}" != 1 ]]; then
  swift build -c release --product ScamShield >/dev/null || status=$?
  SCAMSHIELD_DEVTOOLS=1 swift build -c release --scratch-path .build-dev --product ScamShield >/dev/null || status=$?
  [[ "$status" == 0 ]] && echo "✔ App builds: production and development configurations"
fi

# Tests create UUID-named UserDefaults suites; remove the files they leave behind.
find "$HOME/Library/Preferences" -maxdepth 1 -type f -E -regex '.*/(scamshield\.tests\.|scamshield\.history\.tests\.|ss\.cap\.|consent\.test\.|outbox\.test\.)[0-9A-F-]{36}\.plist' -delete 2>/dev/null || true
exit "$status"
