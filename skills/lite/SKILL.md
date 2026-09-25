---
name: lite
description: Structured interview that decomposes a goal into a todolist.csv, gets approval, then dispatches each step to ralph.sh for headless execution. Only asks questions and writes CSV rows — never executes work itself. Use when the user says "lite mode", "guide me", "decompose this", or "walk me through it".
---

# LITE — Guided decomposition → ralph execution

Three phases, sequential. Never skip. Each phase produces a concrete artifact before advancing.

## Phase 1: Decompose

One question at a time. Map each answer to a `todolist.csv` row.

**Mandatory questions (in order, ask one per turn):**

1. **Goal** — "What's the overall thing you want done?" → condensed 1-line in `/tmp/ralph/<slug>/goal.md`
2. **Scope** — "What files/dirs/systems does this touch?" → written to scope.md
3. **Constraints** — "Any constraints? (time, tools, don't touch X)" → written to constraints.md
4. **Steps** — "What are the atomic steps, in order?" For each step, ask:
   - Step description (1 line)
   - Acceptance criteria / how to verify it's done (1 line)
   - Any dependencies on earlier steps

Write each step as a row to `todolist.csv` (pipe-delimited, no header ambiguity):

```
step|task|verify|status
1|Count .sh files in repo|Output file contains a number|pending
2|Write count to config|config.yml has count field|pending
```

Confirm with user after each row: "Step N: {task}. Verify: {verify}. Correct?"

When all steps are recorded and user confirms "that's all" → proceed to Phase 2.

## Phase 2: Approve

Show the full todolist.csv as a markdown table. Say:

> **Plan ready.**
> | Step | Task | Verify |
> |---|---|---|
> | 1 | ... | ... |
>
> Approve to execute? (y/n/edit)

- If "y" → proceed to Phase 3.
- If "edit" → ask which row and what to change, apply edit, re-present table. Loop until approved.
- If "n" → say "ok, aborted. Deleted /tmp/ralph/<slug>/." (remove the dir).

## Phase 3: Execute

For each row where `status=pending`:

1. Write task brief to `/tmp/ralph/<slug>/<step>-<slug>.md` (task + verify + context from scope.md + constraints.md)
2. Run: `pi --provider featherless --model deepseek-ai/DeepSeek-V4-Flash --nc -p "$(cat ...)" > result_<step>.md`
   — if session model isn't v4-flash, use session model instead
3. Verify: `pi -p "Verify: {criteria}\nResult: $(cat result_<step>.md)" > verify_<step>.md`
4. Check verify for pass keywords (`grep -qiE '^(pass|ok|yes|true|✓)'`). Pass → `done`. Fail → retry up to 3x with context.md. 3 fails → `failed`, continue.
5. Show one-line update per step.

After last step → show summary (pass/fail per step).

## Re-entry

User says "add another task" or "now do X" after completion → back to Phase 1. Preserve existing `/tmp/ralph/<slug>/` context. Append new rows to the same todolist.csv.

## File layout

```
/tmp/ralph/<slug>/
├── goal.md              # Phase 1
├── scope.md             # Phase 1
├── constraints.md       # Phase 1
├── todolist.csv         # Phase 1→2 (pipe-delimited, 4 cols)
├── <step>-<slug>.md     # Phase 3 — task brief per step
├── result_<step>.md     # Phase 3 — output per step
├── verify_<step>.md     # Phase 3 — verification output per step
├── context.md           # Phase 3 — accumulated failure context per retry
└── summary.md           # Phase 3 — final report
```

## Model routing

- **Phase 1 & 2 (LITE itself):** Uses whatever model is in the active pi session. No override needed — this is the conversation agent.
- **Phase 3 (execution):** Uses `deepseek-ai/DeepSeek-V4-Flash` on featherless (cheap). Override to current session model if user requests it. Set via `--model` flag on the `pi -p` invocation.

## Boundaries

- LITE never executes work. It only asks questions, writes CSV rows, and dispatches to `pi -p`.
- No parallel execution — sequential per todolist.csv order.
- No mid-run human approval during Phase 3 (steps run autonomously). Approval happened in Phase 2.
- Failure of one step does not abort subsequent steps. Mark failed, continue.
- No workspace isolation — writes to `/tmp/ralph/<slug>/`. User is responsible for cleanup.

## Trigger

User says: "lite mode", "guide me", "decompose this", "walk me through it", "break this into steps", "/lite".
