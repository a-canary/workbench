---
name: dream-status
description: Show dream processing state and today's journal entry counts
allowed-tools: Read, Glob, Bash
---

# Dream Status

Show what dream has processed and what today's journal holds.

## Steps

1. **Processing state.** Read the incremental tracker:
   ```bash
   cat ~/.claude/dream/state/processed.json 2>/dev/null
   ```
   If absent, report that dream has never run.

2. **Today's journal.** Locate it and count entries by type:
   ```bash
   J=~/.claude/dream/journal/$(date +%F).md
   [ -f "$J" ] && grep -c '^## \[mistake' "$J"
   [ -f "$J" ] && grep -c '^## \[correction' "$J"
   [ -f "$J" ] && grep -c '^## \[hallucination' "$J"
   [ -f "$J" ] && grep -c '^## \[indirection' "$J"
   [ -f "$J" ] && grep -c '^## adaptation' "$J"
   ```

3. **Available journals.** List how many days have been journaled:
   ```bash
   ls ~/.claude/dream/journal/*.md 2>/dev/null | wc -l
   ```

4. **Freshness.** Count sessions newer than the last processed run:
   ```bash
   find ~/.claude/projects/*/*.jsonl -newer ~/.claude/dream/state/processed.json 2>/dev/null | wc -l
   ```
   If any exist, note that `/dream` would process new data.

## Display

```
## Dream Status

### Processing
- Sessions processed: {count}
- Last run: {newest mtime in processed.json, or "Never"}
- Unprocessed/changed sessions: {n}

### Today's journal ({date})
| Type           | Count |
|----------------|-------|
| mistake        | {n}   |
| correction     | {n}   |
| hallucination  | {n}   |
| indirection    | {n}   |
| adaptation     | {n}   |

### Archive
{n} day(s) journaled under ~/.claude/dream/journal/
```
