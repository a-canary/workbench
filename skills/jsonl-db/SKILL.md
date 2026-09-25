---
name: jsonl-db
description: Append, query, update, and GC a .jsonl file as a git-tracked event bus or task store using lib/jsonl-db.ts. Use when an agent needs to write open tasks, emit events, poll for work, or compact resolved entries — and git history should serve as the audit log. Do NOT use when you need transactions, concurrent writers, or sub-millisecond indexed queries — use SQLite instead.
---

# jsonl-db

Git-tracked event bus and task store. One JSON object per line; append-only by default; GC compacts resolved entries to an archive file. At <100k rows all operations complete in <1s.

## Quick start

```ts
import { JsonlDb } from './lib/jsonl-db'

const db = new JsonlDb('tasks.jsonl')
await db.append({ id: 'evt_01', type: 'task.created', status: 'open', ts: Date.now(), payload: {} })
const open = await db.query(e => e.status === 'open')
await db.update('evt_01', { status: 'resolved' })
await db.gc(e => e.status === 'resolved', 'archive.jsonl')
```

## Event schema convention

```jsonl
{"id":"evt_01","type":"task.created","status":"open","ts":1751234567,"payload":{}}
{"id":"evt_02","type":"task.completed","status":"resolved","ts":1751234890,"ref":"evt_01"}
```

- `id` — unique, stable (use `crypto.randomUUID()` or `evt_<timestamp>`)
- `type` — dot-namespaced verb (`task.created`, `task.assigned`, `task.resolved`)
- `status` — `open` | `resolved` | `archived`; drives GC predicate
- `ts` — Unix seconds (not ms — stays readable in `jq`)
- `ref` — optional foreign key to parent event

## API

| Method | Description |
|---|---|
| `append(event)` | Add one event to end of file |
| `query(predicate)` | Scan all lines, return matches (in-memory) |
| `update(id, patch)` | Rewrite matching line with merged patch |
| `gc(resolvePredicate, archivePath?)` | Partition file: keep non-matching, move matching to archive |
| `watch(cb)` | Call `cb` on each new appended line (fs.watch poll) |

## GC / compaction

```ts
const { kept, archived } = await db.gc(e => e.status === 'resolved', 'archive.jsonl')
```

Rewrites `tasks.jsonl` with only unresolved events; appends resolved ones to `archive.jsonl`. Both files stay git-tracked — history is the full event log.

## Implementation

See [`lib/jsonl-db.ts`](lib/jsonl-db.ts) — zero dependencies, ~80 lines, copy into any project.

Self-check: `bun skills/jsonl-db/lib/jsonl-db.ts` — exercises append/query/update/gc + watch() against a temp file, asserts, prints OK.
