# workbench

Complete, tested agent configuration: model through skills. Not a generic tool — this is the working setup, qualified by harness-bench.

## Layers

| layer | directory | what it does |
|---|---|---|
| model | `models/` | weights, quant, parameters (context, KV, temp) |
| proxy | `proxy/` | routing, load balancing, failover (arc-llm-proxy) |
| harness | `pi/` | pi config, extensions, hooks, skills symlink |
| skills | `skills/` | the actual know-how (symlinked from arc-skills) |
| hardware | `hardware/` | V100, local GPU, vast instance playbooks |

## Qualification

Every change must pass `harness-bench` with no quality regression:

```sh
# Before
~/repos/harness-bench/bin/bench run core --model <model> --label before
# After
~/repos/harness-bench/bin/bench run core --model <model> --label after
# Compare
~/repos/harness-bench/bin/bench compare before after
```

Latest results in `BENCH/`.

## Nightly policy

1. PRs must contain tests + harness-bench delta + evidence of value
2. Nightly build = stable + all open PRs (run by agents-pub)
3. PR merges to stable when: nightly users approve OR survives 3 nightly builds without related errors
4. Private (aaron) uses stable + own WIP PRs

## Replicate

```sh
# 1. Clone and install skills
git clone https://github.com/a-canary/workbench
cd workbench
ln -sfn $(pwd)/skills ~/.pi/skills

# 2. Copy pi config
cp pi/models.json ~/.pi/agent/
cp pi/settings.json ~/.pi/agent/
cp pi/pi-settings.json ~/.pi/

# 3. Copy extensions
cp pi/extensions/*.ts ~/.pi/agent/extensions/

# 4. Configure proxy (or use your own)
# See proxy/README.md

# 5. Verify with harness-bench
cd ~/repos/harness-bench
bin/bench run smoke --model <your-model> --label verify
```
