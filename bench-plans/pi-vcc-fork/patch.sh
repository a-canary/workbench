#!/usr/bin/env bash
# Apply worker-authored patches (filename order) to the fork clone, then run the
# fork's own test suite. No patches = NO_PATCH, and the verdict step fails on an
# over-budget tail rather than pretending work happened.
set -euo pipefail; . "$(dirname "$0")/env.sh"; D=$(dirname "$0")
shopt -s nullglob; ps=("$D"/patches/*.patch)
if [ ${#ps[@]} -eq 0 ]; then echo "NO_PATCH" | tee "$RUN/patch.txt"; exit 0; fi
for p in "${ps[@]}"; do echo "== $(basename "$p")"; git -C "$FORK" apply --stat "$p" | tail -2; git -C "$FORK" apply "$p"; done
tests=skipped
if [ -x "$FORK/node_modules/.bin/vitest" ]; then
  ( cd "$FORK" && npm test >"$RUN/patch-test.log" 2>&1 ) && tests=pass || tests=fail
  tail -6 "$RUN/patch-test.log"
fi
{ echo "PATCHED $(git -C "$FORK" diff --stat | tail -1)"; echo "tests=$tests"; } | tee "$RUN/patch.txt"
