# Setup

Dream runs in two phases on two models: a **fast** model pages the bulk of the
conversation logs (cheap, high-volume), and a **smart** model reads the distilled
journal and makes the single system edit. The skill itself is just markdown and
needs no install — but the two phases are custom subagents (`collector`,
`adapter`), and Claude Code only spawns subagents it can find in an agents
directory. So there is a one-time install:

## 1. Register the agents

The agent prompts ship at `skills/dream/agents/`. Symlink them where Claude Code
discovers subagents (`~/.claude/agents/`), so `/dream` can spawn `collector` and
`adapter` by name. Use the shared `bin/install-skill-agents.sh` (idempotent;
backs up any wrong-target link or real file to `~/trash/` before replacing —
same contract as `install-behavioral-rules/inject.sh`):

```bash
bin/install-skill-agents.sh dream collector.md adapter.md
```

(Path can be relative to any cwd — the script resolves `~/.claude/skills/` via
the symlink into this repo.) (`~/.claude/skills/` is itself a symlink into this
repo, so the agent files track the repo — edit once, installed everywhere.)

## 2. Configure a fast and a smart model

Dream's two phases map directly onto the two model handles every arc-* system
shares: **fast** (collector) and **smart** (adapter). Don't pick them per-skill —
run the base-layer picker once and dream inherits the choice:

```
/select-models
```

That discovers reachable providers, asks you for a fast and a smart model,
validates each by running it, and registers both inside
`~/repos/arc-agents/config.json` — adding the two chosen entries to
`exec_cli_alias` and setting top-level `fast_alias` / `smart_alias` pointers:

- **fast** → `collector` — bulk paging, the expensive part by volume; pick a
  cheap, high-throughput model.
- **smart** → `adapter` — makes exactly one edit; spend the capable model here.

The agent files (`collector.md`, `adapter.md`) name a model in frontmatter so
Claude Code can spawn them. `/select-models` rewrites that frontmatter to point
at the chosen aliases, so the picker is the single place model selection lives.
If you skip the picker, the shipped defaults (`model: haiku` for collector,
`model: opus` for adapter) still work as long as those names resolve in your
environment. The Task-tool subagent loader only honors `opus | sonnet | haiku |
inherit`; a provider alias like `minimax` here silently falls back to `inherit`
and burns Opus-class tokens on bulk paging.

The rule holds either way: **fast model collects, smart model adapts.** Running
both phases on one model still works — it just costs more, since the high-volume
paging no longer runs on the cheap model.

## 3. (Optional) Nightly cron

Dream is incremental (`scripts/pipeline.py` tracks processed sessions by mtime),
so it is safe to run unattended. To work the backlog down nightly, point a
system cron entry at a wrapper that invokes `/dream`. Keep `--limit` in place so
a cold start can't spawn thousands of agents in one tick.
