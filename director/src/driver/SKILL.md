---
name: director
description: AFK-capable mission driver that reads MISSION.md / AGENTS.md / CHOICES.md, runs a gap-analysis loop, delegates to worker agents via the event bus, and gates progress on verified evidence. Use to drive a repo toward mission completion without constant human steering. Do NOT use for single-task execution — use /task instead.
---

# director

Framework-agnostic mission driver. Reads goals, identifies gaps, delegates work, watches for results, gates on evidence. Depends only on flat files — no arc-agents, no DB required.

## Invocation

```
/director [repo-root]        # infers repo root if omitted; prompts for binding confirmation
/director --afk              # skip confirmation, run until idle
/director pause              # write .arc/director/director.paused, halt after current tick
/director resume             # clear .arc/director/director.paused, replay events since pause, resume loop
```

This repo root is the **parent repo** — where director state lives (`.arc/director/`)
and whose `AGENTS.md` declares the bindings for itself and any other repos it manages.
One `/director` instance owns one parent repo; managing multiple repos means declaring
them as delegation targets in this repo's `AGENTS.md`, not running multiple directors
against a shared vault path.

## Onboarding (first run)

Only runs once, when the parent repo has no `AGENTS.md` (or one with no `## Director
bindings` section). The full procedure — discovery script, batched setup questions,
`AGENTS.md` write, `directors.json` registration — lives in
[`ONBOARDING.md`](ONBOARDING.md). Load it only on that first unconfigured boot;
steady-state ticks never need it. It ends by falling through into the boot sequence
below (boot step 4's confirmation gate still applies).

## Boot sequence

1. Read (first found): `MISSION.md`, `AGENTS.md`, `CHOICES.md`, `objective.md`
2. Restate objective — what done looks like, what the constraints are
3. Read `AGENTS.md` bindings section; if missing or incomplete, run
   [Onboarding](#onboarding-first-run) instead of prompting ad hoc
4. If not `--afk`: block for user confirmation or edit before proceeding
5. Replay `.arc/events.jsonl` (full scan) to reconstruct open/inflight/pending-QA task set
6. Enter the director loop

## Idle backstop

Director is event-driven, not polling — `idle` sleeps until the next feedback event.
A cron backstop wakes a fresh tick regardless, so a dropped event can't silently stall
the mission. Cadence, the `ScheduleWakeup` gotcha, and the token/stall tradeoff are on
the `scheduler` binding in [`BINDINGS.md`](BINDINGS.md).

## Reference

Bindings, the `.arc/` working-file layout, and the event-bus schema are in [`BINDINGS.md`](BINDINGS.md). Read it when you need to know what a binding accepts, where state lives, or what shape events take; read this file for the operator procedure below.

## Director loop

Each tick: **budget** (governor binding; at weekly limit → critical-only:
qa.failed critical-failure/security still dispatch, all else pauses; bypass
triggers ignore budget) → **capacity** (advisory binding; CLI error → proceed
unbound + capacity.failopen; route run/park/escalate, record every provider
response) → **gap-analysis** (reads gaps.md state header + open-gap rows ranged,
never whole — see read discipline below; open gaps → delegate; none +
inflight/pending-QA → sleep; none at all → idle) → **watch event bus** →
**heartbeat** (5 min in --afk; backstop cron wakes idle) → **end**: regenerate
`.arc/local-dev-dash/main.html`.

**Tick read discipline — never dump state files whole.** `gaps.md` is
append-only: only the top `state:`/`prev-state:` header and any open-gap rows
drive a tick; the rest is historical log (a steady-state file runs 200+ lines /
~8k tokens for one live line).

Read the header with the **Read tool, `offset: 1, limit: 12`** — never through
Bash. `sed -n`, `head -N`, `cat`, and `grep … | tail` land their full output in
context verbatim and can't be re-scoped once emitted. On 20260725 six Bash pokes
at `gaps.md` across two mission-local directors burned ~28k tokens, and
the worst (7.3k) was a `grep -n '^state:…' | tail -40` — the command this
section used to recommend. A `^state:` grep is NOT cheap here: each `state:`
line is a multi-thousand-char prose paragraph, so 43 header hits out-costs
reading the whole file. Need one older value → `grep -n` that single literal and
Read only the hit's range.

**Keep the header one line of state, not a changelog.** Writing `state:` /
`prev-state:`, cap at ~200 chars: state token, tick number, timestamp, short
clause. Narrative — what was refuted, why, what shipped — goes in the gap row or
the commit message, not the header every future tick must re-read and re-pay.

`grep` `blocked.md` for open rows rather than `cat`; parse
`feedback.jsonl`/`events.jsonl` by redirecting to `/tmp` and grepping the OPEN /
unprocessed rows, never piping the full dump into context. Full-file reads of
these files each tick were the single largest director-tick token bleed.

Full event-bus routing and event schema are in [`BINDINGS.md`](BINDINGS.md).
The load-bearing gates that never relax:

- `task.completed` → evidence paths must exist, else reject + re-queue → dispatch `/qa`
- `qa.passed` non-production → close gap. **Production → do NOT close at merge**:
  merge per on-task-verified binding, deploy, re-dispatch `/qa` against the LIVE
  surface (hard-merge §6) with `phase:post-deploy`; only that post-deploy pass
  closes the gap (critical/truthfulness finding → rollback, re-gap).
- `qa.failed` → check bypass triggers; retry or new slice. `task.failed` →
  blocked.md; re-gap or surface. `user.feedback` → sink + batch by
  (feature, version, resource); at threshold → `/qa`, never a direct task.

State (written to gaps.md header): delegating · waiting:inflight · waiting:qa ·
idle · paused (sentinel) · budget-exceeded (critical-only until reset/raised).

## What director does NOT own

- How worker agents are spawned (declared in `AGENTS.md` bindings)
- Worktree/workspace creation (owned by `/task`)
- QA execution (owned by `/qa`)
- Feedback injection (owned by `/feedback`)
- Ledger tracking (owned by `arc-agents` if installed)
- Dashboard display (owned by `arc-webui` if installed)
