# workbench

Tested agent configuration: model through skills. Pins exact component versions, qualifies the combination with harness-bench, ships what works.

## Model

```
arc-skills (skills axis) ──┐
arc-llm-proxy (routing) ───┼──► workbench (pins versions, qualifies, ships)
harness-bench (testing) ───┘
```

Each component repo improves its own axis. workbench's job is integration + qualification — "this specific combo, tested together, works."

## Layers

| layer | where | what |
|---|---|---|
| skills | `arc-skills` (pinned) | the know-how |
| proxy | `arc-llm-proxy` (pinned) | routing, load balancing, failover |
| pi config | `pi/` (here) | models.json, extensions, settings |
| model params | `models/` (here) | context, KV, quant, per-model tuning |
| hardware | `hardware/` (here) | V100, vast instance playbooks |
| bench plans | `bench-plans/` (here) | V100 inference, pi-vcc-fork |
| nightly | `nightly/` (here) | qualification build |

## Install

```sh
git clone https://github.com/a-canary/workbench
cd workbench
./bootstrap.sh
```

Pulls the pinned component versions, installs config, symlinks skills.

## Qualification

Every change must pass harness-bench with no quality regression:

```sh
~/repos/harness-bench/bin/bench run core --model <model> --label before
# ... make change ...
~/repos/harness-bench/bin/bench run core --model <model> --label after
~/repos/harness-bench/bin/bench compare before after
```

Results in `BENCH/`. Nightly build in `nightly/`.

## Nightly policy

1. PRs require tests + harness-bench delta + evidence of value
2. Nightly build runs stable + all open PRs through harness-bench
3. Auto-merge: survive 3 nightlies with no related regressions
4. Private (aaron) uses stable + own WIP PRs


## Daily sweep (automated)

 runs daily (03:00 UTC cron):
1. Checks pinned component repos for new commits
2. If changes: runs harness-bench core suite
3. If tests pass: updates  with new  ref, commits, pushes
4. If tests fail: leaves manifest as-is, logs failure

This is the automation that keeps the workbench current with component improvements.

## Manifest

`manifest.json` pins the exact tested combination. Bump a component's `ref` and re-run nightly qualification before committing the manifest change.
