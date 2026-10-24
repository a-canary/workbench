# EA Framework

**A TypeScript library for running Evolutionary Algorithms on LLM artifacts.**

Evolve prompts, skills, configs, pipelines, and code — with caching, parallelism, backoff, and Hermes integration. No external dependencies.

---

## What Problem Does It Solve?

You have an artifact (prompt, skill, config, pipeline) and you want to find a better version of it. EA searches by maintaining a population of variants, measuring fitness, keeping the best, and creating new variants through mutation and crossover — until satisfied.

This library provides:
- **Canonical EA lifecycle** — seed → validate → evaluate → select → breed → repeat → terminate
- **Eval caching** — SHA256 by genome content, not individual ID
- **Parallel evaluation** — configurable concurrency with backoff on transient failures
- **Standard log schema** — machine-parseable JSONL for dashboards and pipelines
- **Event hooks** — agent controls artifact lifecycle (`onRetire`) and monitoring
- **All artifact types** — free-text, structured-text, code, config-tuple, pipeline, concept

---

## Quick Start

```bash
npm install
npx ts-node examples/01-preamble-evolution.ts
```

```typescript
import { EA, EAConfig, Genome } from './src';

const config: EAConfig = {
  artifactType: 'free-text',
  populationSize: 8,
  survivalRate: 0.5,
  elitismCount: 1,
  maxGenerations: 20,
  earlyStopRounds: 5,
  crossoverRate: 0.3,
  evalCacheEnabled: true,
  evalConcurrency: 4,
  breedConcurrency: 4,
  backoffBaseMs: 1000,
  backoffMaxMs: 16000,
  backoffMaxRetries: 3,
  runId: `ea_${Date.now().toString(36)}`,
  logPath: './ea_log.jsonl',
  lineagePath: './lineage_postmortem',

  validate: async (ind) => {
    const words = (ind.genome._text ?? '').trim().split(/\s+/);
    if (words.length > 35) return { valid: false, reason: 'wordcount exceeds 35' };
    if (words.length < 5)  return { valid: false, reason: 'wordcount below 5' };
    return { valid: true, reason: '' };
  },

  evaluate: async (ind) => {
    // Your benchmark / LLM judge / test suite goes here
    const score = Math.random(); // placeholder
    return { fitness: score, metrics: {}, judgeOutput: '' };
  },

  mutate: async (parent) => ({ ...parent, genome: { ...parent.genome, _text: parent.genome._text + '.' } }),
  crossover: async (a, b) => ({ ...a, genome: { _text: (a.genome._text ?? '') + ' ' + (b.genome._text ?? '') } }),
  seed: async (i) => ({ _text: `seed preamble ${i}` }),
  select: (pop, scores) => [...pop].sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0)).slice(0, Math.floor(pop.length * 0.5)),
  shouldTerminate: (gen, best, stagnant) => stagnant >= 5,
};

const ea = new EA(config);
const result = await ea.run();
console.log(`Best: ${result.bestFitness} — ${JSON.stringify(result.bestIndividual.genome)}`);
```

See `examples/` for full working examples.

---

## Project Structure

```
evolutionary/
├── src/
│   ├── ea.ts         # EA orchestrator class + all core types
│   ├── index.ts      # Public API — re-exports everything
│   ├── cache.ts      # SHA256 eval cache
│   ├── logger.ts     # Append-only JSONL lineage logger
│   ├── backoff.ts    # Exponential backoff with jitter
│   ├── semaphore.ts  # Concurrency limiter
│   └── utils.ts      # ID generation, individual factory, helpers
├── examples/
│   ├── 01-preamble-evolution.ts   # Free-text, programmatic 3-signal eval
│   ├── 02-config-evolution.ts     # Config-tuple, single-point crossover
│   └── 03-pipeline-llm-judge.ts   # Pipeline with external LLM judge call
├── docs/
│   ├── ARCHITECTURE.md   # Code walkthrough and design decisions
│   └── HERMES.md         # Hermes skill integration
└── README.md (this file)
```

---

## Core Concepts

### Artifact Types

| Type | Description | Example |
|------|-------------|---------|
| `free-text` | Plain natural language text | Preamble, behavioral principle |
| `structured-text` | Text with YAML/JSON schema | SKILL.md, tool description |
| `code` | Syntactically valid, potentially testable | Python, TypeScript, shell |
| `config-tuple` | Fixed-dimension categorical vector | Memory strategy (D1–D6) |
| `pipeline` | Multi-step process with state | 5-stage LLM pipeline |
| `concept` | Not directly executable | Safety policy, routing strategy |

### EA Lifecycle

```
REPEAT UNTIL terminate():
  1. VALIDATE  — gate check before spending eval cost
  2. EVALUATE  — measure fitness (parallel, with backoff)
  3. SELECT    — keep survivors, identify casualties
  4. BREED     — create replacements (parallel)
```

### The Retire Event

When an individual leaves the living population it becomes **retired**. The framework emits `retire`; the agent decides what to do with the artifact (archive, discard, promote to best-ever). This separation is intentional — the agent has full context the framework lacks.

### Eval Cache

The cache is keyed on **genome content hash** (SHA256), not individual ID. Identical genomes always get a cache hit, regardless of generation. This means:
- Re-evaluating the same genome is free
- When you disable `evalCacheEnabled: false`, you get fresh scores — useful for measuring score variance

### Standard Log Schema

Every run produces an append-only JSONL log. Events: `run_start`, `seed`, `validate`, `evaluate`, `generation_end`, `select`, `retire`, `bred`, `terminate`, `run_end`.

```jsonl
{"type":"run_start","run_id":"preamble_ea_abc123","ts":"2026-05-07T10:00:00Z","params":{...}}
{"type":"seed","run_id":"preamble_ea_abc123","gen":0,"id":"g0_p0","breed":"seed","parents":[],"ts":"..."}
{"type":"validate","run_id":"preamble_ea_abc123","gen":0,"id":"g0_p0","valid":true,"reason":"","ts":"..."}
{"type":"evaluate","run_id":"preamble_ea_abc123","gen":0,"id":"g0_p0","fitness":0.72,"cached":false,"metrics":{...},"ts":"..."}
{"type":"generation_end","run_id":"preamble_ea_abc123","gen":0,"best_id":"g0_p0","best_fitness":0.72,"mean":0.61,"pop_size":8,"invalid_count":1,"ts":"..."}
{"type":"terminate","run_id":"preamble_ea_abc123","gen":6,"reason":"early_stop_5_rounds","best_id":"g5_p1","best_fitness":0.84,"ts":"..."}
{"type":"run_end","run_id":"preamble_ea_abc123","ts":"2026-05-07T18:32:01Z"}
```

---

## Examples

### Example 1 — Preamble Evolution (free-text, programmatic eval)

`examples/01-preamble-evolution.ts`

Evolves short preambles using 3 programmatic signals: keyword match, length efficiency, instruction clarity. Demonstrates the full EA loop with caching, parallel eval, and a console monitor.

```bash
npx ts-node examples/01-preamble-evolution.ts
```

### Example 2 — Config Evolution (config-tuple, single-point crossover)

`examples/02-config-evolution.ts`

Evolves a 6-dimension memory strategy config using single-point crossover and dim-flip mutation. Demonstrates Config-Tuple artifact type with mutation at specific dimensions.

```bash
npx ts-node examples/02-config-evolution.ts
```

### Example 3 — Pipeline Evolution (LLM judge)

`examples/03-pipeline-llm-judge.ts`

Evolves pipeline manifests using an external LLM judge. Shows how to wire in an HTTP-based judge (e.g., Hermes llm-judge skill) and how to handle long-running eval with backoff.

```bash
npx ts-node examples/03-pipeline-llm-judge.ts
```

---

## API Reference

### `EA` class

```typescript
const ea = new EA(config);     // config = full EAConfig
await ea.run();                // run full EA (may take hours)
ea.getState();                 // EARunState for monitor polling
ea.isDone();                   // boolean — run complete?
ea.getBest();                 // best Individual | null
ea.on('terminate', handler);   // listen for termination
ea.on('eval_retry', handler);  // listen for backoff retries
```

### `EAConfig` (minimal)

```typescript
const config: EAConfig = {
  artifactType: 'free-text',
  populationSize: 8,
  survivalRate: 0.5,
  elitismCount: 1,
  maxGenerations: 20,
  earlyStopRounds: 5,
  crossoverRate: 0.3,
  llmMutationRatio: 0.7,
  evalCacheEnabled: true,
  evalConcurrency: 4,
  breedConcurrency: 4,
  backoffBaseMs: 1000,
  backoffMaxMs: 16000,
  backoffMaxRetries: 3,
  runId: string,
  logPath: string,
  lineagePath: string,

  // Required callbacks
  validate: async (ind) => ({ valid: boolean, reason: string }),
  evaluate: async (ind) => ({ fitness: number, metrics: object, judgeOutput: string }),
  mutate: async (ind) => Individual,
  crossover: async (a, b) => Individual,
  seed: async (i) => Genome,
  select: (pop, scores) => Individual[],
  shouldTerminate: (gen, bestFitness, stagnantRounds) => boolean,

  // Optional hooks
  onRetire: async (ind, cause) => {},      // agent decides artifact lifecycle
  onGenerationEnd: async (gen, best, mean) => {},
  onMonitor: (state) => {},
};
```

### Key types

```typescript
interface Genome { _text?: string; _yaml?: object; _code?: string; _tuple?: unknown[]; [key: string]: unknown }
interface Individual { id, gen, status, genome, fitness, metrics, judgeOutput, cached, validationReason, retireCause, parents, breedMethod, createdAt, evaluatedAt }
interface EARunState { runId, generation, popSize, evaluatedCount, retiredCount, bestFitness, meanFitness, stagnantRounds, totalEvaluations, cacheHitRate, cacheSize }
interface EARunResult { runId, generationsCompleted, bestIndividual, bestFitness, totalEvaluations, cacheHitRate, terminated, terminateReason }
interface RubricDim { [dimension: string]: number }
interface Judgment { rubric: RubricDim; overall: number; reasoning: string; model: string; timestamp: number }
interface TrialResult { trialId, individualId, taskId, judgment, latencyMs, costUsd?, cached? }
type GeneAny = GeneBool | GeneCategorical | GeneFloat  // bool{c}, categorical{options[]}, float{min,max}
```

---

## Hermes Integration

See `docs/HERMES.md` for how to use this library from within the Hermes agent framework. The EA Framework Hermes skill lives at `~/.hermes/profiles/<profile>/skills/evolutionary/` and references this repo as the implementation.

In short, the Hermes skill provides the **design contract** (conventions, terminology, decision wizard, operator prompts), and this repo provides the **runnable implementation** (TypeScript library).

---

## References

| Name | Relevance | Key Idea |
|------|-----------|----------|
| [DSPy GEPA](https://arxiv.org/abs/2501.12597) | hermes-agent-self-evolution | Reflective mutation — reads execution traces to select mutation type |
| [Promptbreeder](https://arxiv.org/abs/2312.06013) | Not yet used | Self-referential prompt improvement; adapts mutation rate during evolution |
| [MIPROv2](https://github.com/stanfordnlp/dspy) | hermes-agent-self-evolution fallback | Bayesian optimization over prompt space |
| [Starlight-SLM](../starlight-slm) | Schematic-first EA | Evolve schematic (YAML) → generate code → test → metrics → selection |
| [DEAP](https://github.com/DEAP/deap) | Config-tuple reference | Standard Python EA library |
| Thompson Sampling | m27-research-opt | Bayesian bandit routing; posterior Beta distribution |

---

## License

MIT