# shellcheck shell=bash
# Shared log-event contract for the nightly self-improve chain.
# nightly-self-improve.sh WRITES these lines; selfimprove-monitor.sh READS them.
# Keeping the format + its grep pattern in one file removes the hidden
# write-here / regex-parse-there coupling the two scripts used to carry.
# Source it: . "$(dirname "$0")/lib/log-event.sh"

# UTC ISO timestamp prefix, e.g. [2026-07-13T04:00:00Z].
ts() { date -u +%FT%TZ; }

# log_event <logfile> <words...> — one "[ts] words..." line.
log_event() { local f="$1"; shift; echo "[$(ts)] $*" >> "$f"; }

# The stage-failure line the monitor greps for. Same string on both sides.
SELFIMPROVE_FAIL="SELFIMPROVE_FAIL"

# log_fail <logfile> <stage> <exit> — normalized failure line.
log_fail() { log_event "$1" "$SELFIMPROVE_FAIL stage=$2 exit=$3"; }
