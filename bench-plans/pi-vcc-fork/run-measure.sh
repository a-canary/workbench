#!/usr/bin/env bash
# shared by baseline.sh (pristine fork) and measure.sh (patched fork)
set -euo pipefail; . "$(dirname "$0")/env.sh"; D=$(dirname "$0")
LABEL=${1:?usage: run-measure.sh <label>}
cd "$D" && bun run measure.ts >"$RUN/$LABEL.txt" 2>"$RUN/$LABEL.err" || { echo "INFRA_FAULT: measure crashed"; tail -20 "$RUN/$LABEL.err"; exit 1; }
cat "$RUN/$LABEL.txt"
