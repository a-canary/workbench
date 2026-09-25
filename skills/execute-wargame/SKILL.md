---
name: execute-wargame
description: Execute a wargame runbook produced by /wargame — enforce the ledger gate (halt on unresolved placeholders), walk moves in order following fork triggers, apply countermoves on failure signals, and halt on abort conditions. Use when the user wants to run/execute a wargame, drive a mission from its .wargame/ runbook, or says "execute-wargame". This runs the runbook; /wargame writes it.
model: claude-sonnet-5
effort: high
---

# Execute wargame

Runs a `.wargame/wargames/<mission>.md` runbook. Enforces the three things the
runbook's prose can't enforce itself: the **ledger gate**, **fork-following**,
and **abort halts**.

## Quick start

```
/execute-wargame <mission>
```

1. **Gate:** `bash <this-skill>/../wargame/scripts/gate.sh <repo>/.wargame`.
   Non-zero exit → STOP, list the unresolved `(variable)`s, ask the user to
   resolve or authorise assumed values. Do not start moves.
2. **Walk:** follow the full protocol in
   [../wargame/EXECUTE.md](../wargame/EXECUTE.md) — load context, execute each
   move, compare to expected observation, take the fork the trigger matches,
   apply countermoves, check abort conditions before every move.
3. **Report:** the path taken, where it stopped (done / halted-at-abort /
   blocked), and any move whose expected observation was wrong in reality (a
   runbook bug to feed back to `/wargame`).

The gate is the only deterministic step (`scripts/gate.sh`, shared with
`/wargame`). Move-walking and forks are judgment — follow EXECUTE.md.

## Rules

- Gate is non-negotiable — unresolved ledger row a move reads → stop and ask.
- Fork triggers are observations; can't observe it → can't take it, say so.
- Abort = halt + report, never work around.
- Executing, not re-wargaming. Reality off every documented branch → stop and
  report the gap, don't invent a new plan.
