---
name: continue
description: Resume protocol — reconstruct work state from evidence, dump six categories (completed, open questions, open assumptions, in-flight, unresolved goals, next steps), file ledger tickets for batches of atomic tasks, then proceed. Use when the user says "continue", "resume", "pick up where we left off", or a session resumes after compaction/interruption.
---

# Continue

Resume without amnesia. Reconstruct state from evidence (git log, ledger rows,
live processes, /tmp artifacts) — never from memory alone. Ticket what can be
ticketed, then proceed in the same turn.

## Procedure

1. **Reconstruct from evidence.** Before writing the dump, check:
   - `git log --oneline -10` + `git status` in the active repo(s)
   - Ledger rows touched by this effort (state + claimed_by)
   - Live processes / worktrees for anything in-flight
2. **State dump — six categories:**
   - **Completed** — done, each with evidence (commit sha, PR, row id)
   - **Open questions** — forks awaiting a ruling; route to /counsel or a
     human-gate, never guess inline
   - **Open assumptions** — assumed without proof; mark which are load-bearing
   - **In-flight** — live process/claim/branch; name the owner (worker id, pane)
   - **Unresolved goals** — mission-level items not started or blocked
   - **Next steps** — ordered, each independently verifiable
3. **Ticket batches of atomic tasks.** Next-step batches that are independent,
   self-contained, and verifiable on their own → file ledger rows (bookie
   create), one row per atomic task, success criteria in body_md. Do NOT
   ticket: single-flow work you will do inline next, or anything blocked on a
   pending ruling.
4. **Proceed.** Execute the first next step immediately after the dump — the
   dump is a checkpoint, not a report-and-stop.

## Rules

- Every "completed" claim carries evidence (sha / PR / row id). No evidence →
  it goes under in-flight, not completed.
- Re-test open assumptions when cheap; if a load-bearing one fails, say which
  next steps it invalidates in the dump.
- Filed tickets are reported as row ids in the closing line, then work continues.
