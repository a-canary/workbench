#!/bin/bash
# nightly/run.sh: run workbench qualification against harness-bench
# Called by cron (agents-pub or local). Results go to BENCH/nightly-<date>.json
#
# Usage: nightly/run.sh [--pr <pr-number>]

set -euo pipefail
WORKBENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS_BENCH="/home/aaron/repos/harness-bench"
DATE=$(date -u +%Y-%m-%d)
RESULT_FILE="$WORKBENCH_DIR/BENCH/nightly-$DATE.json"
PR="${PR:-}"

echo "workbench nightly: $(date -u)"

# Run harness-bench core suite
cd "$HARNESS_BENCH"
LABEL="nightly-${DATE}"
if [[ -n "$PR" ]]; then
    LABEL="nightly-${DATE}-pr${PR}"
fi

# Run benchmark
bin/bench run core --model "$(jq -r '.providers.v100.models[0].id' "$WORKBENCH_DIR/pi/models.json")" \
    --label "$LABEL" 2>&1 | tee "/tmp/workbench-nightly-$DATE.log"

# Write result stub (actual result parsing from bench output goes here)
echo "{\"date\":\"$DATE\",\"pr\":$PR,\"label\":\"$LABEL\",\"status\":\"completed\"}" > "$RESULT_FILE"

echo "result: $RESULT_FILE"
