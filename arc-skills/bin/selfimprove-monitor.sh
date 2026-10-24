#!/usr/bin/env bash
# Morning check for the nightly self-improve chain. Deterministic, no LLM.
# Cron'd 07:30 UTC (# >>> arc-skills:selfimprove-monitor >>>). Appends one
# OK|FAIL line per morning to ~/vault/selfimprove/monitor.log (the operator
# dashboard surfaces that file — the FAIL line IS the alert).
# ponytail: "each adaptor made <=1 change" check dropped — adaptors write prose
# journals, no machine-readable change record; adaptation-review + the nightly
# regression-reviewer already judge that with a model.
set -uo pipefail
_lib="$(dirname "$(readlink -f "$0")")/lib/log-event.sh"
. "$_lib" || { echo "FATAL: cannot source $_lib" >&2; exit 1; }
LOG="${LOG:-$HOME/.cache/arc-hygiene/nightly.log}"
OUT="${OUT:-$HOME/vault/selfimprove/monitor.log}"
mkdir -p "$(dirname "$OUT")"
reasons=""
[ -f "$HOME/.claude/dream/journal/$(date -d yesterday +%F).md" ] || reasons+=" no-journal-yesterday"
section=$(tac "$LOG" 2>/dev/null | awk '/nightly start/{print; exit} {print}' | tac)
# "nightly done" must be TODAY's (box is UTC, nightly ends ~03:30Z, monitor 07:30Z) —
# a stale prior-day section means the nightly never fired (e.g. dangling symlink,
# lost crontab) and that must read FAIL, not OK.
echo "$section" | grep -q "\[$(date -u +%F)T[^]]*\] nightly done" || reasons+=" no-nightly-done-today"
echo "$section" | grep -q "$SELFIMPROVE_FAIL" && reasons+=" $(echo "$section" | grep -o "$SELFIMPROVE_FAIL stage=[^ ]*" | tr '\n' ',')"
if [ -z "$reasons" ]; then
  log_event "$OUT" OK
else
  log_event "$OUT" "FAIL$reasons"
fi
