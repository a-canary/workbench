---
name: profiling-ladder
description: Pick the right optimization rung. Move down only after exhausting the rung above. Session > memory > skill > pipeline | TS > C-lib > ASM.
---

# profiling-ladder

Two ladders. Climb to the bottleneck, optimize the cheapest rung first.

## Ladder 1 — Where the work lives

```
session  →  memory  →  skill  →  pipeline
```

| Rung | What it means | Cost to change |
|---|---|---|
| **session** | Solve it inline in one turn | Lowest. No persistence. |
| **memory** | Save a fact/preference so future sessions skip the rediscovery | Low. One file. |
| **skill** | Codify a recurring procedure as a SKILL.md | Medium. Affects all future invocations. |
| **pipeline** | Move it into deterministic code (TS module, shell script, defineModule) | Highest. Now it's software, with tests and bugs. |

**Rule:** Stay at the highest rung that works. Promote down only when:
- The pattern has repeated 3+ times (skill, not session)
- The procedure is deterministic and judgment-free (pipeline, not skill)
- The cost of getting it wrong is high enough to want CI on it (pipeline)

## Ladder 2 — Implementation language

```
TypeScript  →  C library (FFI/wasm)  →  inline ASM / hand-tuned kernel
```

| Rung | When to drop down |
|---|---|
| **TypeScript** | Default. Almost always sufficient. |
| **C lib** | Profiled hot loop dominating runtime; algorithm already optimal; the lib already exists (don't write C, link it) |
| **ASM / kernel** | Profiled hot loop dominating runtime; the C lib does not exist or has measurable overhead; you can show the speedup with `perf` |

**Rule:** Profile before dropping. "Probably faster" is not a reason. The cost of C interop and ASM debugging dominates unless the speedup is at least 10×.

## How to apply

When asked to optimize:

1. **Measure first.** What's the actual bottleneck? Time? Tokens? Disk? Without numbers, you're guessing.
2. **Find the current rung.** Where does the work live today?
3. **Try climbing.** Can it move *up* a rung? (A pipeline replaced by a memory entry is the biggest win.)
4. **If you must drop:** drop exactly one rung. Re-measure. Don't skip to the bottom.

## Common mistakes

- Writing a pipeline for a one-off (skipped session → memory → skill)
- Rewriting in C before profiling (skipped measurement)
- "Optimizing" by adding caching/parallelism without measuring (added complexity, no proven win)
- Optimizing the wrong rung (faster ASM kernel when the bottleneck was a sync disk write)

## When NOT to invoke

- Code is fast enough. "Fast enough" is defined by the user's UX, not your aesthetics.
- The bottleneck is human time, not machine time. Optimize the workflow, not the runtime.
