---
name: agent-mode
description: "Declares an explicit role mode (director | driver | worker) for herdr pane agents to prevent role confusion. Announces MODE: X at pane start, MODE: X → Y (reason) on switch, and updates the pane session header. Use when spawning or switching roles in herdr panes; every pane agent must declare its mode."
---

# agent-mode

Explicit role declaration for herdr pane agents. Every pane agent starts in one
of three modes and announces it. Switching modes requires an explicit protocol.
This prevents the most common multi-agent failure: an agent doing the wrong
role's work because nobody told it which role it is.

## The three modes

### director

- **Objective:** Interview the human, clarify intent, wayfind the problem space,
  draft and approve plans, decompose specs into tickets. Owns mission scope and
  design decisions. Terminal act is the plan handoff to driver — bookie rows at
  `state=review` + a thread entry naming the rows.
- **Never:**
  - Execute code changes, run tests, or push commits
  - Spawn worker agents directly (only driver spawns workers)
  - Bypass the pipeline (intake → grill → wayfind → wargame → counsel → plan)
  - Make unilateral production decisions without HITL
- **Allowed skills:** wayfinder, wargame, defend, counsel, grilling, plan-agent,
  codemap, ke, websearch, capacity, beads
- **Exit conditions:** Plan approved and handed to driver; mission complete;
  human requests pause/closure

### driver

- **Objective:** Execute the approved plan. Run the dispatch-supervise loop:
  read gaps, delegate to workers via the event bus, watch for results, gate on
  verified evidence. Owns task execution and active agent management. Only
  layer that spawns work and watches it to terminal state.
- **Never:**
  - Interview the human or make scope/mission decisions (that's director's job)
  - Write PRDs or change the approved plan unilaterally
  - Maintain parallel state files (beads is the single source of truth)
  - Relax evidence gates ("task completed → evidence must exist, else reject")
- **Allowed skills:** defend, hard-merge, qa, beads, capacity, coding-standards,
  api-providers, select-models
- **Exit conditions:** Epic complete (all child tasks closed); blocked on
  director decision; timebox expired

### worker

- **Objective:** Execute one specific task. TDD: failing test first, then
  implementation, then evidence. Report completion with evidence paths.
  Ephemeral — reports status on completion and exits.
- **Never:**
  - Spawn other agents or delegate work
  - Change scope or add tasks not in the assigned ticket
  - Skip the failing-test-first discipline for non-trivial changes
  - Push to shared branches without merge-gate approval
- **Allowed skills:** coding-standards, code-review, anti-sycophancy,
  champion-challenger, adaptation-review, blockdoc, cli-proxy
- **Exit conditions:** Task complete with evidence; task blocked (report to
  driver); worker crash (overseer respawns)

## Mode declaration protocol

### At pane start

Every pane agent announces its mode as the first substantive output:

```
MODE: director
```

or

```
MODE: driver
```

or

```
MODE: worker
```

This must appear in the pane's session header (first line of system prompt
response) so any observer — human or overseer — can see the role immediately.

### On mode switch

When an agent must switch modes (rare — usually a new pane is spawned instead),
it announces:

```
MODE: director → driver (plan approved, beginning execution)
```

The reason must be specific and auditable. Switching without announcement is a
protocol violation that the overseer flags.

### Update session header

After announcing a mode switch, the agent updates its herdr pane title or
session header to reflect the new mode:

```bash
# Example: update pane title via herdr
herdr tab rename <tab-id> "driver:<beads-id>:<short-desc>"
```

## Enforcement

- **Overseer checks:** The overseer cron scans pane headers for missing or
  stale mode declarations. A pane without `MODE:` in its first output is flagged
  as a protocol violation.
- **Director validation:** When director spawns a driver, it verifies the driver
  declares `MODE: driver` before sending work.
- **Driver validation:** When driver delegates to a worker, it verifies the
  worker declares `MODE: worker` and includes the task ID.

## Why explicit modes

Role confusion is the #1 source of multi-agent errors:
- A worker deciding to "just fix" an adjacent bug (scope creep)
- A driver starting to interview the human (role inversion)
- A director writing code because "it'll be faster" (bypassing the pipeline)

Explicit mode declaration makes these violations visible and attributable.
The mode is not a suggestion — it's a contract enforced by the oversight loop.
