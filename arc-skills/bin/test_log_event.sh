#!/usr/bin/env bash
# Self-check for bin/lib/log-event.sh — the shared write/read contract for the
# nightly self-improve chain. Run: bash bin/test_log_event.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$REPO_ROOT/bin/lib/log-event.sh"

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
F="$T/nightly.log"

# ts is a UTC ISO stamp.
echo "$(ts)" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' \
  || { echo "FAIL: ts format: $(ts)" >&2; exit 1; }

# log_event writes "[ts] words...".
log_event "$F" nightly start
tail -1 "$F" | grep -qE '^\[[^]]+\] nightly start$' \
  || { echo "FAIL: log_event line: $(tail -1 "$F")" >&2; exit 1; }

# log_fail writes the exact string the monitor greps for.
log_fail "$F" dream 124
line="$(tail -1 "$F")"
echo "$line" | grep -q "$SELFIMPROVE_FAIL stage=dream exit=124" \
  || { echo "FAIL: log_fail line: $line" >&2; exit 1; }

# The monitor's parse (grep -o "$SELFIMPROVE_FAIL stage=[^ ]*") must extract the stage.
echo "$line" | grep -o "$SELFIMPROVE_FAIL stage=[^ ]*" | grep -q "^$SELFIMPROVE_FAIL stage=dream$" \
  || { echo "FAIL: monitor cannot parse stage from: $line" >&2; exit 1; }

echo "ok"
