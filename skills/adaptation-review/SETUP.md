# Setup

`/adaptation-review` runs one deterministic Python pass (no model) plus one
review phase on the **smart** model. The skill itself is just markdown and the
extractor needs no install — but the review phase is a custom subagent
(`regression-reviewer`), and Claude Code only spawns subagents it can find in an
agents directory. One-time install:

## 1. Register the agent

The agent prompt ships at `skills/adaptation-review/agents/`. Symlink it where
Claude Code discovers subagents (`~/.claude/agents/`), so the skill can spawn
`regression-reviewer` by name. Use the shared `bin/install-skill-agents.sh`
(idempotent; backs up any wrong-target link or real file to `~/trash/` before
replacing — same contract as `install-behavioral-rules/inject.sh`):

```bash
bin/install-skill-agents.sh adaptation-review regression-reviewer.md
```

(Path can be relative to any cwd — the script resolves `~/.claude/skills/` via
the symlink into the arc-skills repo.) (`~/.claude/skills/` is itself a symlink
into the arc-skills repo, so the agent file tracks the repo — edit once,
installed everywhere.)

## 2. Model

Only one phase uses a model: the reviewer, which judges whether a flagged change
is a real regression. That's a **smart**-model job, and the agent is pinned to a
real tier (`model: opus`) for the same reason dream's adapter is — the Task
loader only honors `opus | sonnet | haiku | inherit`, so an alias there silently
falls back to the inherited model (see the diagnostics-on-opus/haiku-only rule in
`~/AGENTS.md`). Phase 1 spends no tokens at all.

## 3. Nightly cron

This is the safety net over the two daily adapters, so it should run **after**
them — late enough that the day's `/dream` and `/token-waste` adaptations are
already in the journal. Point a system cron entry at a wrapper that invokes
`/adaptation-review` and set `REVIEW_DAY` to the day that just ended so the
trailing window is unambiguous across the midnight boundary:

```cron
# >>> arc-skills:adaptation-review >>>
# 03:30 — after /dream and /token-waste have written the day's adaptations
30 3 * * *  REVIEW_DAY=$(date -d yesterday +%F) claude -p /adaptation-review \
              > ~/.cache/arc-hygiene/adaptation-review.log 2>&1
# <<< arc-skills:adaptation-review <<<
```

`-p` = print (headless, no TTY). `REVIEW_DAYS` overrides the window (default 10).
The skill writes its report to the log; nothing auto-applies — a human reviews
when convenient, exactly like the other hygiene skills. If `/dream` and
`/token-waste` run earlier in the night, just make sure this fires after them.

The review is **read-only and idempotent**: re-running it the next night re-reads
the (now 10-day) window and re-checks every surface against current state. It
makes no edits, so there is nothing to make safe against repeated runs.
