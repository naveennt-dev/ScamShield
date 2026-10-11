#!/usr/bin/env bash
# Phase 3 offline verification.
#   scripts/offline-check.sh            wait for the Mac to go offline, run checks, wait for it to come back
#   scripts/offline-check.sh --online   run the same checks without requiring offline (dry run)
#
# NOTE: don't click or type while it runs — the app self-test opens real windows and real input
# reaching them (e.g. a click on ✕) is indistinguishable from a user dismissing the scanner.
#
# Checks: internet really unreachable · local stack healthy · ML service + rules + risk engine via
# the local API · macOS app self-test (screen capture + Vision OCR + API + result UI) · no socket
# from ScamShield processes to any non-loopback address during the run.
set -uo pipefail
cd "$(dirname "$0")/.."
OUT="${OUT:-macos/build/offline-check}"
mkdir -p "$OUT"
REQUIRE_OFFLINE=1
[[ "${1:-}" == "--online" ]] && REQUIRE_OFFLINE=0
fail=0
pass() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fail=1; }
online() { curl -s -o /dev/null --max-time 3 https://www.apple.com || curl -s -o /dev/null --max-time 3 https://1.1.1.1; }

if [[ $REQUIRE_OFFLINE == 1 ]]; then
  echo "Waiting for the network to go OFFLINE (turn Wi-Fi off / unplug Ethernet)…"
  for _ in $(seq 1 300); do online || break; sleep 2; done
  if online; then echo "Still online after 10 minutes — aborting."; exit 2; fi
  pass "internet unreachable (apple.com and 1.1.1.1 time out)"
fi

# Egress monitor: sample sockets of node (Next.js), python (ML service) and ScamShield.app.
: > "$OUT/sockets.txt"
( while true; do
    for pid in $(pgrep -f "next start -H 127.0.0.1|ml/inference/service.py|ScamShield.app/Contents/MacOS/ScamShield"); do
      lsof -nP -a -p "$pid" -i 2>/dev/null | tail -n +2 >> "$OUT/sockets.txt"
    done
    sleep 0.5
  done ) &
MON=$!

scripts/local-stack.sh status > "$OUT/stack.txt" 2>&1
grep -q "ML service : up" "$OUT/stack.txt" && pass "ML service up" || bad "ML service down"
grep -q "Local API  : up" "$OUT/stack.txt" && pass "local API up" || bad "local API down"
grep -q "'llm': 'disabled'" "$OUT/stack.txt" && pass "LLM layer disabled (no OpenRouter)" || bad "LLM layer not disabled"

RESP="$(curl -s --max-time 10 -X POST http://127.0.0.1:3000/api/v1/analyze/message -H 'content-type: application/json' \
  -d '{"message":"Dear customer aapka account block ho jayega. OTP batao abhi, verify at sbi-kyc-verify.xyz"}')"
echo "$RESP" > "$OUT/analysis.json"
python3 - "$OUT/analysis.json" <<'PY' && pass "rules + ML (service) + risk engine via local API" || bad "local analysis"
import json, sys
d = json.load(open(sys.argv[1]))["data"]
print(f"     → {d['classification']} / {d['riskLevel']} / {d['riskScore']} / model={d['model']}")
assert d["classification"] == "scam" and d["model"] and d["model"]["backend"] == "service"
assert any(s["source"] == "rules" and s["available"] for s in d["signals"])
PY

EXPECT_BACKEND=1 macos/scripts/smoke-test.sh "build/offline-check/selftest" > "$OUT/selftest.txt" 2>&1
grep -E "^(FAIL|SKIP)|SMOKE|real ScreenCapture|local API analysed|Vision OCR" "$OUT/selftest.txt" | sed 's/^/     /'
grep -q "SMOKE TEST PASSED" "$OUT/selftest.txt" && pass "macOS app self-test (capture/OCR/API/result UI)" || bad "macOS self-test"
grep -q "PASS real ScreenCaptureKit capture (region)" "$OUT/selftest.txt" && pass "real screen capture" || echo "SKIP real screen capture (Screen Recording not granted to this build)"

kill $MON 2>/dev/null; wait $MON 2>/dev/null
NONLOCAL="$(grep -E "TCP|UDP" "$OUT/sockets.txt" | grep -vE "127\.0\.0\.1|\[::1\]|localhost|\*:" | sort -u)"
if [[ -z "$NONLOCAL" ]]; then
  pass "no ScamShield process connected to a non-loopback address ($(wc -l < "$OUT/sockets.txt" | tr -d ' ') socket samples)"
else
  bad "non-loopback sockets observed:"; echo "$NONLOCAL" | head
fi

if [[ $REQUIRE_OFFLINE == 1 ]]; then
  echo "Done. Turn the network back on; waiting for it…"
  for _ in $(seq 1 300); do online && break; sleep 2; done
fi
[[ $fail == 0 ]] && echo "OFFLINE CHECK PASSED" || echo "OFFLINE CHECK FAILED"
exit $fail
