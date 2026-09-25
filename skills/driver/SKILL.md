---
name: driver
description: AFK-capable mission driver that reads MISSION.md / AGENTS.md / CHOICES.md, runs a gap-analysis loop, delegates to worker agents via the event bus, and gates progress on verified evidence. Spawned by director in a persistent herdr pane to drive a repo toward mission completion. Do NOT invoke directly — use /director to delegate.
---

# driver

Framework-agnostic AFK spec driver. Reads a spec, identifies gaps, delegates work, watches for results, gates on evidence. Runs in a persistent herdr pane until the spec is complete or blocked.

**Scope:** Spec-scoped, not repo-scoped. A spec may affect one repo or many. For multi-repo specs, the driver spawns repo-workers (bg_delegates) in each affected repo's worktree and coordinates across them.

## Invocation

Spawned by director via: `herdr tab create --label "driver-[spec]" --cwd [repo-or-vault-path]`
with system prompt: `<skill>/sys_driver.md`

For multi-repo specs, the driver creates worktrees for each affected repo and spawns repo-workers there.

```
/driver [spec-file]       # run gap-analysis loop on spec
/driver --afk             # run until idle (no confirmation)
/driver pause             # write .arc/driver/driver.paused, halt after current tick (also skips scheduled/cron work)
/driver resume            # clear .arc/driver/driver.paused, resume loop
```

**Pause scope:** The sentinel halts the main loop AND causes scheduled/cron ticks to skip (cron wakes, sees sentinel, exits without processing). Resume replays missed events since pause timestamp.

## Boot sequence

1. Read (first found): `MISSION.md`, `AGENTS.md`, `CHOICES.md`, `objective.md`
2. Restate objective — what done looks like, what the constraints are
3. Read `AGENTS.md` bindings section; if missing, report to director via beads
4. Query beads for open/in_progress tasks; grep last session output for in-flight context
5. Enter the driver loop

## Driver loop

Each tick: **gap-analysis** (query central beads DB `~/vault/director/.bd/` for open/in_progress issues assigned to this repo; open → delegate via harness task system; none + inflight → sleep; none at all → idle) → **await harness task notifications** → **heartbeat** (5 min; backstop cron wakes idle).

**Idle backstop:** Driver is event-driven, not polling — `idle` sleeps until the next task notification. A cron backstop (overseer) wakes a fresh tick regardless, so a dropped notification can't silently stall the mission.

**Communication:** Delegate via bg_delegate or bg_run_pi_attested. Workers are ephemeral — report status on completion. No file-based event bus. Update beads issue status based on task results.

**Worker crash handling:** If worker crashes/infinite-loops/stalls, overseer detects and notifies driver. Driver spawns fresh worker (tasks are idempotent — safe to re-run from scratch).

**Dependency failure:** If beads CLI fails, report error to `herdr.pane.repair` with attempt to repair, restore from backup, or recover data. Do not limp along on degraded state.

**Compute allocation is the scheduler's job**, not the driver's. Director sets policy (priority, timebox); scheduler enforces rate limits, subscription windows, local GPU throughput (V100/P600), and provider contention. Driver runs when scheduled, stops when timebox expires.

**State discipline:** The central beads DB (`~/vault/director/.bd/`) is the single source of truth for task state. Never maintain parallel state files (gaps.md, blocked.md, events.jsonl). Query beads via CLI; never dump beads DB into context.

**Cross-repo decomposition:** When decomposing an epic into tasks, create task tickets in the central DB with attribution fields:
- `repo:` — target repository
- `worktree:` — leave blank (worker sets at claim time)
- `assigned_to:` — target agent or "unassigned"

**Single-writer state transitions:**
- Driver: `epic` → decomposes into `task` tickets, `task` → `blocked`/`deferred`
- Driver validates worker evidence before closing `task` tickets
- Driver never transitions `task` to `in_progress` (worker does that)

**Task result handling (never relax):**
- Task completed → evidence paths must exist, else reject + re-queue → dispatch `/qa`
- QA passed (non-production) → close beads issue. **Production → do NOT close at merge**: merge per on-task-verified binding, deploy, re-dispatch `/qa` against LIVE surface (hard-merge §6) with `phase:post-deploy`; only that post-deploy pass closes the issue (critical/truthfulness finding → rollback, re-gap)
- QA failed → check bypass triggers; retry or new slice
- Task failed → mark beads issue blocked; re-gap or surface to director via beads
- User feedback → batch by (feature, version, resource); at threshold → `/qa`, never a direct task

**Post-merge sequence (production):**
1. Merge (DefendMerge passed)
2. Deploy to live surface
3. Run QA (e2e) as bg_delegate/agent_browser against live service — this is a gate
4. If QA passes: cleanup worktree, close beads issue, report complete, pane closes
5. If QA fails: do NOT clean up; report failure + evidence to director; director decides (rollback? fix? accept?)
6. Monitoring handoff: per-repo monitoring script writes to standard log; overseer watches logs. Driver does NOT do ongoing monitoring.

State (beads issue status): open · in_progress · blocked · deferred · closed

## Completion notification

When the driver finishes an epic (all child tasks closed) or blocks, notify the director:

```bash
~/vault/director/scripts/wake-director.sh "Epic <epic-id> complete. All tasks closed."
# or on block:
~/vault/director/scripts/wake-director.sh "Epic <epic-id> blocked: <reason>."
```

This ensures the director is aware of driver results without requiring active monitoring. The director may not be running — the script spawns or wakes it.

## Blocking protocol

When blocked:
1. Mark relevant task ticket `blocked` in central beads DB with block reason in description
2. Create escalation ticket if director attention needed
3. Sleep and wait for unblock (director or overseer will handle)

## Defense gates (Defend* family)

Use the [defend skill](../defend/SKILL.md) gate family at critical junctions:
- **DefendPlan** (counsel): wayfinder result → build dispatch
- **DefendMerge** (workhorse): worker diff → git merge (same as /hard-merge)
- **DefendDeploy** (counsel): qa-passed artifact → public deploy

**Minimum capability:** Defense reviews must use the tier specified by the defend skill. If that model tier is unavailable via auto-llm, escalate to director for HITL — do not fall back to a weaker model.

ATTACKS go back to director for HITL; work proceeds on CLEAR or recorded human override.

## What driver does NOT do

- Make scope or mission decisions (that's director's job)
- Run indefinitely without heartbeat (overseer will detect stall)
- Make unilateral production decisions (gate via beads to director)
