# workbench-nightly

Nightly qualification of workbench PRs against harness-bench.

## Steps
1. clone — checkout workbench main + open PR branches
2. stable-bench — run harness-bench core on stable (main)
3. pr-bench — run harness-bench core on each open PR
4. compare — compute deltas, flag regressions
5. report — write results to workbench BENCH/, post PR comments

## Decision rule
- PR survives 3 consecutive nightlies with no related regression → eligible for merge
- Any related task regression → PR flagged, counters reset
