# Setup

Token-waste runs in two phases on two models, exactly like `/dream`: a **fast**
model confirms the bulk of detector candidates (cheap, high-volume), and a
**smart** model reads the day's tally and makes the single system edit. The skill
itself is just markdown + a Python detector and needs no install — but the two
phases are custom subagents (`waste-analyst`, `waste-adapter`), and Claude Code
only spawns subagents it can find in an agents directory. So there is a one-time
install:

## 1. Register the agents

The agent prompts ship at `skills/token-waste/agents/`. Symlink them where Claude
Code discovers subagents (`~/.claude/agents/`), so `/token-waste` can spawn
`waste-analyst` and `waste-adapter` by name. Use the shared
`bin/install-skill-agents.sh` (idempotent; backs up any wrong-target link or
real file to `~/trash/` before replacing — same contract as
`install-behavioral-rules/inject.sh`). The `adapter.md:waste-adapter.md`
rename avoids shadowing `/dream`'s `adapter.md`:

```bash
bin/install-skill-agents.sh token-waste waste-analyst.md adapter.md:waste-adapter.md
```

(Path can be relative to any cwd — the script resolves `~/.claude/skills/` via
the symlink into this repo.) (`~/.claude/skills/` is itself a symlink into this
repo, so the agent files track the repo — edit once, installed everywhere.)

## 2. Configure a fast and a smart model

Token-waste's two phases map onto the same two model handles every arc-* system
shares: **fast** (waste-analyst) and **smart** (waste-adapter). Don't pick them
per-skill — the model split is fixed in each agent's frontmatter, not chosen:

- **`waste-analyst`** scores the detector shortlist; high-volume, cheap →
  `model: haiku`.
- **`waste-adapter`** makes exactly one edit; the high-stakes judgment →
  `model: opus`.

The rule: **fast model analyzes, smart model adapts** — but both are pinned to
first-party Claude tiers (`haiku`/`opus`) and are **not** set by `/select-models`.
These agents are spawned via the Task tool, whose subagent loader only honors
`model: opus|sonnet|haiku|inherit`; a provider alias here would silently fall back
to the inherited model, and a provider outage must never take down a self-healing
loop. The fast/smart aliases `/select-models` registers are for the alias-CLI exec
path (worker spawns, pipeliner's `fast`/`smart` refs) — a different execution layer.
See `~/AGENTS.md` (diagnostics opus/haiku-only rule) and `dream` for the same split.

## 3. (Optional) Nightly cron

The detector is deterministic and the skill writes one file per day to `/tmp`, so
it is safe to run unattended. To run it nightly, point a system cron entry at a
wrapper that invokes `/token-waste` (see the `schedule-hygiene` skill). Keep the
session-scan bounded to "today" so a cold start can't spawn an analyst per
historical session.

## Relationship to dream

Token-waste and dream are twins: dream fixes **effectiveness**, token-waste fixes
**token economy**. They share the JSONL source, the deterministic-extraction-first
philosophy, and — for Phase 2 — the same daily journal
(`~/.claude/dream/journal/YYYY-MM-DD.md`), where the waste-adapter's `## adaptation`
block is tagged `source: token-waste` so it's distinguishable from dream's own.
Run them independently; their Phase-1 outputs never collide.
