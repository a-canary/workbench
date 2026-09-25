---
name: select-models
description: One-time setup to pick and register the fast + smart models arc tooling uses. Use when first installing arc-skills, when arc-agents/config.json lacks fast_alias/smart_alias, or to change which fast/smart models the arc tools use.
---

# select-models

arc-skills is the base install. Every other arc-* system (arc-agents, arc-webui, pipeliner) needs to know **which two models to use**: a *fast* one for cheap high-volume work and a *smart* one for the few high-stakes steps. This skill discovers what's available on the machine, lets the user choose, validates each pick by running it, then registers both inside the single source of truth — `arc-agents/config.json`:

```jsonc
// ~/repos/arc-agents/config.json (after running this skill)
{
  "exec_cli_alias": {
    "opus-max":      "claude --model opus --effort max {prompt}",
    "minimax-fast":  "pi -p --provider minimax --model MiniMax-M2.7 --thinking low {prompt}",
    // ...other aliases unchanged
  },
  "fast_alias":  "minimax-fast",   // <- set by this skill
  "smart_alias": "opus-max",       // <- set by this skill
  "pool_caps":     { /* unchanged */ },
  "default_alias": "minimax-build" // unchanged
}
```

`{prompt}` is the substitution point — a consumer replaces it with the actual prompt. Pipeliner and arc-agents both resolve `fast_alias`/`smart_alias` through `exec_cli_alias`, so there is one map of aliases and two pointers naming the fast and smart ones. No parallel config file.

## Procedure

### 1. Discover providers

Run the discovery script. It checks env vars and the `pass` store and prints a table.

```bash
bash ~/.claude/skills/select-models/scripts/discover.sh
```

Each line is `<provider>\t<source>\t<status>`. Treat only `status=ok` rows as usable. Possible providers: `anthropic` (built-in `claude` models: opus/sonnet/haiku, or a logged-in `claude` CLI), `minimax`, `openrouter`, `chutes`.

### 2. Build candidate CLI templates

From the reachable providers, form candidate command templates. Each MUST contain `{prompt}` exactly once. Known-good shapes:

| Provider | Engine | Fast template | Smart template |
|---|---|---|---|
| anthropic | claude | `claude --model haiku {prompt}` | `claude --model opus --effort max {prompt}` |
| minimax | pi | `pi -p --provider minimax --model MiniMax-M2.7 --thinking low {prompt}` | `pi -p --provider minimax --model MiniMax-M2.7 --thinking high {prompt}` |
| openrouter | pi | `pi -p --provider openrouter --model <model> {prompt}` | `pi -p --provider openrouter --model <model> {prompt}` |

Rule (matches arc-agents config validation): a `claude --model X` template is only valid when `X ∈ {opus, sonnet, haiku}`. Provider models (minimax, etc.) MUST run through `pi -p --provider …`, never `claude --model`.

For each candidate, also pick a short **alias name** to use as the key inside `exec_cli_alias`. Convention: `<provider>-<tier>` (e.g. `minimax-fast`, `opus-max`). If the same alias name already exists in arc-agents/config.json with a different command, the writer overwrites it — that is intentional (re-running this skill replaces the prior pick).

### 3. Ask the user to choose

Use AskUserQuestion with two questions — one for the **fast** model, one for the **smart** model — offering only templates backed by a reachable provider. Recommend: fast = cheapest high-throughput option (haiku or minimax-low); smart = most capable (opus-max). If only one provider is reachable, you may still split fast/smart by its own tiers (e.g. minimax low vs high thinking).

### 4. Validate each pick by running it

Before writing anything, confirm each chosen template actually works:

```bash
bash ~/.claude/skills/select-models/scripts/validate.sh '<fast-template>'
bash ~/.claude/skills/select-models/scripts/validate.sh '<smart-template>'
```

Each substitutes a trivial health-check prompt, runs the CLI, and exits 0 only if it returned text. If validation fails, tell the user which one failed and the stderr tail, then either pick a different candidate or stop — **do not register an unvalidated model.**

### 5. Register the picks in arc-agents/config.json

Only after both validate:

```bash
bash ~/.claude/skills/select-models/scripts/write-config.sh \
  <fast-alias-name>  '<fast-template>' \
  <smart-alias-name> '<smart-template>'
```

It merges both entries into `exec_cli_alias`, sets top-level `fast_alias` and `smart_alias`, and writes the config atomically (temp + rename). The script echoes the result — show it to the user.

Default target is `~/repos/arc-agents/config.json`. Override with `ARC_AGENTS_CONFIG=/path/to/config.json` if the user keeps arc-agents elsewhere.

### 6. Confirm

- [ ] `arc-agents/config.json` parses and contains both new entries in `exec_cli_alias`
- [ ] `fast_alias` and `smart_alias` are set and each names a key that exists in `exec_cli_alias`
- [ ] Both templates contain `{prompt}` exactly once
- [ ] Both were validated in step 4

## Notes

- **Idempotent.** Re-running just overwrites the two entries and the two pointers — safe to run anytime the user wants to switch models. Other aliases (`opus-medium`, `minimax-build`, etc.) and `pool_caps`/`default_alias` are preserved.
- **One source of truth.** There is no `~/.config/arc-skills.json`. arc-agents/config.json is the only model-config file the arc-* stack reads. Pipeliner reads `fast_alias`/`smart_alias` from the same file as named refs; arc-agents resolves aliases via the same `exec_cli_alias` map already used for spawn/worker invocation.
- **Why validate by invoking, not by key-presence:** a key can be present but expired, rate-limited, or the CLI misconfigured. Running a one-token probe is the only honest check that the model will actually answer. Dead aliases that pass key-presence checks but die on first real invocation would silently kill every downstream worker.
- **Why register inside arc-agents/config.json instead of writing a parallel file:** arc-agents/config.json already has the alias map (`exec_cli_alias`), the schema validator (`ConfigSchema` in `src/config/load.ts`), and the resolver (`resolveAlias`) — adding two more pointer fields is cheaper than a second config file with its own parser, loader, and divergence risk.

## Related

- `dream` — its `collector`/`adapter` subagents are spawned via the Task tool, whose subagent loader only honors `model: opus|sonnet|haiku|inherit`. They are therefore pinned to first-party Claude tiers (`collector: haiku`, `adapter: opus`) and this skill does **not** rewrite their `model:` fields — a `fast`/`smart` alias there would silently fall back to the inherited model, and self-healing must not depend on a provider being up. The fast/smart aliases registered here are for the alias-CLI exec path (worker-shell spawns, pipeliner's `fast`/`smart` named refs), a different execution layer than Task-spawned subagents. See `~/repos/arc-skills/GLOBAL-RULES.md` (diagnostics opus/haiku-only rule).
- `arc-agents/src/config/load.ts` — `ConfigSchema`, `loadConfig`, `resolveAlias`, and (after task #11) `resolveFast`/`resolveSmart`.
- `pipeliner` — reads `fast_alias`/`smart_alias` from arc-agents/config.json as named refs (after task #12); does NOT splice them into the Bayesian sampling pool.
