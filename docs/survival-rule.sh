#!/bin/bash
# survival-rule.sh: check if a PR has survived 3 nightly builds
# Usage: survival-rule.sh <pr-number>
#
# Reads nightly results from BENCH/nightly-*.json and checks:
# 1. PR was included in >= 3 nightly builds
# 2. No related task regressed in any of those builds
# 3. No explicit rejection

set -euo pipefail

PR="${1:?usage: survival-rule.sh <pr-number>}"
BENCH_DIR="$(cd "$(dirname "$0")/../../BENCH" && pwd)"
REPOS="/home/aaron/repos"

# Find all nightly results that included this PR
included=0
rejected=0
regressed=0

for f in "$BENCH_DIR"/nightly-*.json; do
  [ -f "$f" ] || continue
  # Check if this PR was in the build
  if ! grep -q "\"pr\":$PR" "$f" 2>/dev/null; then
    continue
  fi
  included=$((included + 1))

  # Check for explicit rejection
  if grep -q "\"pr\":$PR.*\"rejected\":true" "$f" 2>/dev/null; then
    rejected=$((rejected + 1))
  fi

  # Check for related task regressions
  if grep -q "\"pr\":$PR.*\"regression\":true" "$f" 2>/dev/null; then
    regressed=$((regressed + 1))
  fi
done

echo "PR #$PR: included in $included nightlies, $rejected rejections, $regressed regressions"

if [ $included -ge 3 ] && [ $rejected -eq 0 ] && [ $regressed -eq 0 ]; then
  echo "APPROVED: PR #$PR survives 3 nightly builds — eligible for merge to stable"
  exit 0
else
  echo "NOT YET: PR #$PR needs more nightly builds or has regressions"
  exit 1
fi
