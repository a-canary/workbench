# Nightly build process (agents-pub)

## What runs nightly

```sh
# In agents-pub, cron at 02:00 UTC
cd ~/repos/agents-pub
driver/driver.sh plans/workbench-nightly
```

## Steps

1. **Checkout stable** — clone workbench at main branch
2. **Apply open PRs** — fetch and apply each open PR's branch
3. **Run harness-bench** — core suite with each PR's config
4. **Record results** — write to workbench's BENCH/nightly-<date>.json
5. **Report** — post results as PR comments + nightly report

## Auto-merge rule

A PR auto-merges to stable when:
- It has been included in 3 consecutive nightly builds, AND
- No harness-bench task that the PR touches has regressed in any of those 3 builds, AND
- No nightly user has explicitly rejected it

Related task regression = any task whose instruction, setup, or verify overlaps with the PR's changed files.

## Rejection

Any harness-bench task regression that is related to the PR's changes:
- PR is flagged with the failing task(s)
- Author must fix or close
- Counters reset (survives 0 builds)
