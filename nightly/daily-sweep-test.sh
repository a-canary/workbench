#!/usr/bin/env bash
# daily-sweep-test.sh — the qualification floor (wb-qiy): a bench run with 0 passes must not qualify.
set -u
here=$(cd "$(dirname "$0")" && pwd)
eval "$(sed -n '/^qualified() {/,/^}/p' "$here/daily-sweep.sh")"
eval "$(sed -n '/^last_tested() {/,/^}/p; /^record_tested() {/,/^}/p' "$here/daily-sweep.sh")"
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
# repos-ewmf: the sweep kept last_tested in manifest.json and committed it on the shared checkout's master.
# Its push is refused, so every Lead's ~/repos/workbench diverged and merged fixes never reached bin/worker-task.
# last_tested now lives in a state file outside the repo; the sweep never commits or pushes the checkout.
DRY_RUN=0; st=$(mktemp -d); WORKBENCH_DIR=$st/wb; mkdir "$WORKBENCH_DIR"; SWEEP_STATE=$st/state/last-tested.json
echo '{"components":{"skills":{"ref":"main"}}}' > "$WORKBENCH_DIR/manifest.json"; cp "$WORKBENCH_DIR/manifest.json" "$st/before"
check "no state file: last_tested is empty" "$(last_tested skills 2>/dev/null)" ""
record_tested skills abc123 >/dev/null 2>&1
check "record then read back" "$(last_tested skills 2>/dev/null)" "abc123"
record_tested pi-extensions def456 >/dev/null 2>&1
check "components are kept apart" "$(last_tested skills 2>/dev/null) $(last_tested pi-extensions 2>/dev/null)" "abc123 def456"
echo 'garbage{' > "$SWEEP_STATE"
record_tested skills ghi789 >/dev/null 2>&1
check "a corrupt state file starts over" "$(last_tested skills 2>/dev/null)" "ghi789"
echo '   ' > "$SWEEP_STATE"
record_tested skills jkl012 >/dev/null 2>&1
check "a whitespace-only state file starts over" "$(last_tested skills 2>/dev/null)" "jkl012"
echo '["not","an","object"]' > "$SWEEP_STATE"
record_tested skills mno345 >/dev/null 2>&1
check "a non-object state file starts over" "$(last_tested skills 2>/dev/null)" "mno345"
SWEEP_STATE=$st/state-file-not-dir/x.json; : > "$st/state-file-not-dir"
check "a failed write returns non-zero" "$(record_tested skills x >/dev/null 2>&1; echo $?)" "1"
SWEEP_STATE=$st/state/last-tested.json
check "manifest.json is untouched" "$(cmp -s "$st/before" "$WORKBENCH_DIR/manifest.json" && echo same)" "same"
check "the sweep never commits or pushes the workbench checkout" \
  "$(grep -cE 'git -C "?\$WORKBENCH_DIR"? (add|commit|push)' "$here/daily-sweep.sh")" "0"
check "the sweep never writes manifest.json" "$(grep -cE "open\(.*manifest\.json.*'w'" "$here/daily-sweep.sh")" "0"
command rm -r "$st"

exit $fails
