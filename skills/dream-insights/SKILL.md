---
name: dream-insights
description: Show the latest dream journal and adaptation without re-running
allowed-tools: Read, Glob, Bash
---

# Dream Insights

Show the most recent journal of observed failure modes and the adaptation the
adapter made — without re-running collection.

## Steps

1. **Find the latest journal:**
   ```bash
   ls -t ~/.claude/dream/journal/*.md 2>/dev/null | head -1
   ```
   If none exists, tell the user to run `/dream` first.

2. **Read it.** It is an append-only markdown file: a series of
   `## [type] title` entries followed (if collection completed) by one
   `## adaptation` block.

3. **Display**, grouped by entry type, then the adaptation:

   ```
   ## Dream Insights — {date}

   ### Observations
   - {N} mistakes, {N} corrections, {N} hallucinations, {N} indirections

   #### Top recurring causes
   1. {root_cause} — {count}× — cost: {rough impact}
      refs: {session.jsonl:line, ...}
   2. ...

   ### Adaptation
   - Surface: {agent|skill|tool|pipeline|script}
   - File: {path}
   - Rationale: {one line}
   - Runners-up: {what was deferred to next run}
   ```

   If no `## adaptation` block is present yet, note that the adapter has not run
   for this journal.

## Arguments

Optional filter passed as an argument:
- `mistakes` / `corrections` / `hallucinations` / `indirections` — show only that type.
- A date `YYYY-MM-DD` — show that day's journal instead of the latest.

## Next actions

- `/dream` — run a fresh pass.
- `/dream-status` — check processing state.
