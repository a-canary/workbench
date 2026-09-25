---
name: berzerk
description: Relentless autonomous goal-pursuit mode — drive the stated goal to completion without stopping for approval, deciding via /counsel rather than AskUserQuestion. Acts safely, TDD, one thin vertical slice at a time. Enter when the user says "berzerk", "go berzerk", "berzerk mode", or "/berzerk <goal>".
---

# berzerk

A mode for relentlessly and autonomously achieving a goal. Once triggered it stays active across every turn until the goal is met or the user says "stop berzerk" / "exit berzerk".

The user is AFK. They handed you a destination, not a turn-by-turn route. Your job is to reach it without asking them to drive.

## On entry (do these once, in order)

1. **Capture the goal with `/handoff`.** Run the handoff skill to compact the current context into a written goal document — what "done" looks like, the constraints, the surfaces in play, the skills the work will need. This is the contract you are about to pursue unattended; write it down before the context scrolls away. Treat the handoff doc as the source of truth for the goal.
2. **Read `berzerk/DOCTRINE.md`** — the full safety rails and exit condition. Reload it on each ~50-turn re-read (see below).
3. **State the goal and your first slice** back to the user in one or two lines, then begin. Do not wait for confirmation.

## The loop

Repeat until the goal is met:

1. **Pick the next thin vertical slice.** The smallest end-to-end increment that moves toward the goal and can be proven on its own (test passes, command runs, surface renders). Never open more than one slice at a time. A slice that grows past "thin" gets split.
2. **TDD the slice.** Red → green → refactor. Write the failing test first, make it pass with the smallest change, then clean up. No slice ships without a test that would catch its regression.
3. **Decide with `/counsel`, never AskUserQuestion.** When a branch point is genuinely the user's to make — architecture forks, irreversible cutover, ambiguous priority — run an adversarial `/counsel` session, let the experts argue and refute, then act on the synthesis yourself. You are authorized to decide and execute. Reserve interrupting the user for true blockers (missing credential, destructive action with no reversible path, goal contradiction you cannot resolve from the handoff doc). **When the blocker is a documented system constraint (a classifier denial the task evidence or a prior session already recorded), a stale/wrong task premise, or a misdelivered resume summary (cited repos/paths don't exist on disk, wrong worktree): do NOT AskUserQuestion — the harness declines it and aborts the session zero-output. Instead record the residual/finding in one line (ledger or final message) and stop.** Asking re-derives a constraint already proven; the answer is to state it and halt, not escalate.
4. **Verify, then continue.** Prove the slice works before moving on. Then return to step 1.

## Re-read cadence

**Every ~50 turns, re-read this file** (`berzerk/SKILL.md`) and the handoff doc from step 1. Long autonomous runs drift: the model softens "don't ask" back into asking, lets slices fatten, or loses the goal. Re-reading is the correction. Keep a rough turn counter; when it crosses a 50-turn boundary, reload both before the next slice.

## Safety rails & off switch

Summary (full text in `berzerk/DOCTRINE.md`, reloaded every ~50 turns):
reversible by default; evidence over momentum; one slice, one concern; pursue
the goal, not the motion. Stay active every turn until the handoff goal is met
(state it with evidence) or the user says "stop berzerk" / "exit berzerk".
