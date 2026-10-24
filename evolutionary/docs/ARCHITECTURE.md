# Architecture

## Design Goals

1. **No external runtime dependencies** — only TypeScript + Node.js stdlib. Import and run.
2. **Framework enforces conventions, agent implements domain** — the EA class handles lifecycle, caching, parallelism, logging. The agent implements `validate`, `evaluate`, `mutate`, `crossover`, `seed`, `select`.
3. **Monitor is external** — the EA exposes state for polling; it does not spawn threads. Long runs are driven by Hermes cron.
4. **Cache by genome content, not individual ID** — SHA256 of serialized genome. Identical content = cache hit. Disable only when you need score variance measurement.
5. **Retire is informational** — the framework emits the event; the agent decides artifact lifecycle.

---

## Source Map

```
src/
├── index.ts       # Public API — re-exports everything
├── types.ts      # All TypeScript interfaces (single source of truth)
├── ea.ts         # EA orchestrator class (main loop)
├── cache.ts      # SHA256EvalCache + NoOpCache
├── logger.ts     # LineageLogger (append-only JSONL)
├── backoff.ts    # withBackoff + sleep
├── semaphore.ts  # Concurrency limiter
└── utils.ts      # ID factory, individual factory, rouletteSelect, pickTwo, helpers
```

---

## EA Lifecycle (as implemented)

```
ea.run()
  │
  ├─ parallelSeed()              → Individual[] (gen 0, all at once)
  │
  └─ evaluateGeneration() [GEN 0]
        ├─ validateAll()          → mark valid/invalid, log validate events
        ├─ partition: cached / uncached
        │     cached → fill fitness from cache, log evaluate (cached:true)
        └─ parallelEvaluate(uncached)
              ├─ Semaphore(evalConcurrency)  — wait for slot
              ├─ withBackoff(evaluate, baseMs, maxMs, maxRetries)
              └─ on retry: emit('eval_retry', {ind, attempt, delayMs, err})
              → log evaluate (cached:false), cache.set(genome, result)
        └─ post-generation: update stagnant, log generation_end,
              call onGenerationEnd(state), call onMonitor(state)

  └─ REPEAT [while !terminated]
        ├─ selectSurvivors()    → elite + config.select() → survivors + casualties
        ├─ log select event
        ├─ retire(casualties)    → for each: log retire, call onRetire hook
        ├─ parallelBreed(count, survivors)
        │     ├─ Semaphore(breedConcurrency)
        │     ├─ useCrossover = random() < crossoverRate
        │     ├─ crossover(a, b) OR mutate(rouletteSelect(survivors))
        │     └─ log bred event
        ├─ population = survivors + replacements
        └─ evaluateGeneration() [NEXT GEN]
              → repeat until terminate()

terminateEA(reason):
  → log terminate event
  → emit('terminate', {reason, best})
  → isDone() = true
```

---

## Caching Strategy

```
Cache key = SHA256(JSON.stringify(genome, Object.keys(genome).sort()))
→ stable across generations; same genome = same key
→ when evalCacheEnabled: false, NoOpCache always returns null

When cache hits:
  → fitness/metrics/judgeOutput filled from cache
  → logged with cached:true
  → totalCacheHits++ (for monitoring)
  → does NOT call config.evaluate() — saves judge compute

When cache misses:
  → calls config.evaluate()
  → cache.set(genome, result)
  → logged with cached:false
```

---

## Semaphore Concurrency

Two independent semaphores:

| Semaphore | Controlled by | Default |
|-----------|--------------|---------|
| `evalConcurrency` | Parallel evaluation | 4 |
| `breedConcurrency` | Parallel breeding | 4 |

These are independent. Breeding is usually much cheaper than evaluation, so they can be set to different values. Both default to 4 because that's a safe general-purpose number.

---

## Backoff

Used only in `parallelEvaluate`, not in `validate` (validation should be fast) or `seed` (seeding happens once). Backoff parameters:

- `backoffBaseMs: 1000` — start with 1s delay
- `backoffMaxMs: 16000` — cap at 16s
- `backoffMaxRetries: 3` — retry up to 3 times

For LLM judges with rate limits, these should match the judge's rate limit behavior. For local test suites, backoff may be unnecessary (set `backoffMaxRetries: 0`).

---

## Log Schema Design

All events are JSONL — one JSON object per line. The `type` field is the discriminator. Every event has `run_id`, `ts`, and (when applicable) `gen`.

Key events:
- `run_start` — params (callbacks stripped before logging), ts
- `seed` — id, gen=0, breed=seed, parents=[]
- `validate` — id, valid:true/false, reason (reason populated even on pass for debugging)
- `evaluate` — id, fitness, cached, metrics
- `generation_end` — best_id, best_fitness, mean, pop_size, invalid_count, cache_hit_rate
- `select` — gen, survivors[], casualties[]
- `retire` — id, cause, fitness, archived:true
- `bred` — id, gen, breed, parents[]
- `terminate` — gen, reason, best_id, best_fitness
- `run_end` — ts

No `archive` event — archive is implicit when `retire.archived: true` is logged. The agent's `onRetire` hook decides whether to actually write files; the log just records the decision.

---

## Types

All types are in `types.ts`. Key discriminants:

- `genome._text` → free-text / structured-text
- `genome._yaml` → structured-text / schematic
- `genome._code` → code
- `genome._tuple` → config-tuple

The Genome interface uses `[key: string]: unknown` to allow arbitrary custom fields. Callers can add `_profileId`, `_runMeta`, etc. without defining new types.