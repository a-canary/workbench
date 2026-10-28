#!/usr/bin/env bash
# daily-sweep-test.sh — the qualification floor (wb-qiy): a bench run with 0 passes must not qualify.
set -u
here=$(cd "$(dirname "$0")" && pwd)
eval "$(sed -n '/^qualified() {/,/^}/p' "$here/daily-sweep.sh")"
fails=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1: got $2 want $3"; fails=1; fi; }
q() { if qualified "$1"; then echo y; else echo n; fi; }
DRY_RUN=0
check "some passes qualify"   "$(q 'run r1  passed 3/5  quality 60.0')"  y
check "zero passes refused"   "$(q 'run r1  passed 0/5  quality 0.0')"   n
check "10/10 qualifies"       "$(q 'run r1  passed 10/10  quality 100.0')" y
check "no summary refused"    "$(q 'INFRA FAULT: every task errored')"   n
DRY_RUN=1
check "dry-run qualifies"     "$(q '[dry-run] would run: bin/bench')"   y
exit $fails
