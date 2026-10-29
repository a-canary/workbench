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

QA profile (`worker-sandbox --role qa`, headless browser + screenshot collapse; optional):

```sh
npx @puppeteer/browsers install chrome-headless-shell   # found under ~/.cache/puppeteer
pip install --user pillow numpy                         # img-collapse
# elsewhere? export WORKER_CHROME=/path/to/chrome-headless-shell-linux64
```

## Quickstart: frontier model decomposes, local model implements

Needs `bd` (beads), `gh`, `pi`, `bwrap`, `jq`, `bun`, `python3`, `curl`, and any OpenAI-compatible local endpoint (llama.cpp, vLLM, Ollama).

1. Point the private lane at your local endpoint (it must listen on 127.0.0.1; the worker jail reaches it through a unix-socket relay and nothing else):

   ```sh
   export WORKER_PRIVATE_PORT=8080 WORKER_PRIVATE_MODEL=qwen2.5-coder-32b
   ```

2. Decompose (Claude, or any frontier model): push a branch whose HEAD commit is a failing test, then file a bead whose description is the task contract:

   ```sh
   cat > task.txt <<'EOF'
   Branch: lane/add-slugify
   Test: bun test src/slug.test.ts
   Timeout: 600
   ---
   Make `bun test src/slug.test.ts` pass. Create ONLY src/slug.ts exporting slugify(s: string): string.
   EOF
   bd create --title "lane: slugify" --type task --label lane:v100 --body-file task.txt
   ```

3. Run the lane. Each pass takes one bead, runs the local model jailed to a worktree, and on GREEN pushes the commit, opens a PR and closes the bead; if the model fails it labels the bead `qwen-failed` for re-decomposition (infra failures get `lane-infra` or `human`):

   ```sh
   bin/lane-run --repo ~/src/myproject --once     # drop --once to keep draining
   ```

4. Review and merge the PR as usual. Worker code never runs on the host: tests run inside the jail too.

Run `bin/merge-gate` on a clean checkout before merging a change to workbench itself. It needs the private-lane endpoint up and a search MCP (`search-mcp` on PATH, or `WORKER_SEARCH_CMD`).

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
4. The operator's private setup uses stable + own WIP PRs


## Daily sweep (automated)

 runs daily (03:00 UTC cron):
1. Checks pinned component repos for new commits
2. If changes: runs harness-bench core suite
3. If tests pass: updates  with new  ref, commits, pushes
4. If tests fail: leaves manifest as-is, logs failure

This is the automation that keeps the workbench current with component improvements.

## Manifest

`manifest.json` pins the exact tested combination. Bump a component's `ref` and re-run nightly qualification before committing the manifest change.

## License

[Apache License 2.0](LICENSE): open source, with an explicit patent grant.
