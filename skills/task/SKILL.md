---
name: task
description: Isolated thin-vertical-slice execution unit — isolated workspace, TDD contract, implementation, independent adversarial review gate, then merge or draft PR only on clear. Use when a gap needs execution in isolation with a verifiable outcome. Do NOT use for exploration or research — use /prototype or /diagnose instead.
---

# task

Isolated, verifiable work unit. One slice, one workspace, one TDD contract, one adversarial reviewer. Merges (or drafts PR) only when the review clears.

## Invocation

```
/task "<gap description>" [--slice path/to/slice] [--acceptance "criteria"]
```

Gap description is a plain-language statement from the director. `/task` owns everything from here to the `on-task-verified` binding action.

## Workspace binding

Workspace type is declared in `AGENTS.md`:

```md
workspace: worktree     # git worktree (default)
workspace: treehouse    # treehouse isolation
workspace: <skill>      # custom skill provides workspace
```

`on-task-verified` declares what happens after adversarial review clears:

```md
on-task-verified: merge      # merge to head immediately
on-task-verified: draft-pr   # open a draft PR for human review
on-task-verified: <skill>    # custom action

> **Primary checkout = production:** never edit/commit dev work there. All dev in worktrees. Merge back via PR to origin, then local main `pull --ff-only`.
```

## Execution sequence

1. **Parse gap** — extract slice path, acceptance criteria, and beads ticket ID from description
2. **Create workspace** — via workspace binding; never touches main checkout
3. **Claim ticket** — update central beads DB: mark ticket `in_progress`, set `worktree:` field to workspace path
4. **Write spec** — `.arc/director/specs/<slice>.md`: goal, acceptance criteria, edge cases, out-of-scope
5. **TDD loop** — write failing tests first, implement until green, no skipped tests
6. **Adversarial review** — independent agent reads spec + diff; actively tries to find logic errors, missing edge cases, spec violations, security issues; produces a verdict
7. **Act on verdict** — clear → mark ticket `defended` in central beads DB, execute `on-task-verified` binding action, mark `merged` on success; blocked → fix and re-review; rejected → mark ticket `blocked`, emit `task.failed`
8. **Emit result** — write `task.completed` or `task.failed` to event bus with evidence; driver validates evidence paths before closing ticket

Worker self-manages ticket state in the central beads DB (`~/vault/director/.bd/`). The driver validates evidence before closing the ticket.

## Evidence requirement

`task.completed` must include existing file paths:

```jsonl
{"type":"task.completed","ref":"evt_01","worker_id":"tdd-agent","slice":"auth/login","evidence":[{"path":"tests/auth.test.ts","description":"12/12 green, all edge cases in spec covered"},{"path":"src/auth/login.ts","description":"implementation matches spec contract"}]}
```

Director rejects `task.completed` without valid, existing evidence paths.

## Adversarial review verdicts

| Verdict | Meaning | Action |
|---|---|---|
| `clear` | No blocking issues | Execute `on-task-verified` binding |
| `blocked` | Issues found, fixable | Fix in same workspace, re-review |
| `rejected` | Fundamental spec problem or unresolvable | Emit `task.failed`, surface to director |

## What task does NOT own

- Which agent does the implementation (declared in `AGENTS.md`)
- QA / user-facing verification (owned by `/qa`)
- Mission-level gap analysis (owned by `/director`)
- Ledger tracking (owned by `arc-agents` if installed)
- Token budget enforcement (owned by `/director`)
- Closing tickets (driver validates evidence and closes)

## Beads handoff protocol

Worker updates its own ticket in the central DB at each stage:

| Stage | State | Notes |
|-------|-------|-------|
| Claim | `in_progress` | Set `worktree:` field |
| Tests pass | — | No state change |
| Review clear | `defended` | Review evidence attached |
| Merge success | `merged` | PR/merge commit ref |
| Review blocked | `in_progress` | Continue fixing |
| Review rejected | `blocked` | Blocker description attached |

Driver validates evidence paths exist before closing the ticket.
