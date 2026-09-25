---
name: ke-memory
description: Use the knowledge engine for durable cross-project memory. Use BEFORE any research, design, or non-trivial investigation (recall prior findings) and AFTER reaching a durable result (persist it). The global memory all agents share across projects.
---

# ke-memory

The knowledge engine (`~/vault/ke/`) is shared durable memory across every project. Two motions:

## Recall before R&D

Before any research, design, or non-trivial investigation, pull what's already known — don't re-derive it:

```
ke recall "<question>"      # alias: ke-recall
ke search "<query>"         # semantic search across all notes
```

## Learn durable findings

When you reach a durable result — a working technique, a settled decision, a measured outcome, a non-obvious gotcha — persist it:

```
ke ingest <file> [--topic <topic>]   # ingest a note into the KE
```

(Or invoke the `ke-learn` skill if your harness provides it.)

What belongs in KE: the **non-obvious why**, cross-project facts, measured results. What does NOT: conversation-only context, or anything the repo/git history already records.
