# CHOICES.md — evolutionary
# DRAFT — pending Director/user approval

---

## Mission

**USR-MSN-0003** — LLM democratization.

Provide a reusable TypeScript library that lets any pipeline or agent run
evolutionary algorithms over LLM artifacts (prompts, skills, configs, pipelines,
code) without external dependencies or managed orchestration.

---

## Scope

### In scope

- `evolutionary/src/` — core EA library (lifecycle, caching, backoff, semaphore, logger, types)
- `evolutionary/examples/` — runnable reference examples per artifact type
- `evolutionary/docs/` — architecture, Hermes integration, migration guide
- Type definitions that serve as cross-project vocabulary: `RubricDim`, `Gene*`,
  `GeneRegistry`, `BreedingStrategy`, `SchematicGenome`
- Integration adapters for downstream consumers (starlight-slm, hermes-agent-self-evolution,
  memory-bench, anti-sycophancy-benchmark)

### Out of scope

- Rewriting Python EA consumers (anti-sycophancy-benchmark, hermes-agent-self-evolution,
  memory-bench/evo, optimize-no-ledge) — they call this library as a dependency
- Building a CLI runner — consumers own their entry points
- Managed cloud execution or job queues — Hermes cron drives long runs
- UI / dashboard — monitoring is via `onMonitor` callback + external dashboard

---

## Architecture

- **Language:** TypeScript, ESM, no runtime dependencies beyond Node.js stdlib
- **No Python in core** — Python consumers call TS library as subprocess or adapt via
  thin wrappers; Python is never imported inside `src/`
- **Callback-first design** — `EAConfig` callbacks own domain logic; `EA` class owns
  lifecycle, concurrency, backoff, caching, logging
- **Opaque genome** — `Genome` is a tagged union of `_text`, `_yaml`, `_code`, `_tuple`
  plus free-form keys; the framework never inspects genome content
- **Content-addressed cache** — SHA256 of serialized genome; disabling the cache is the
  only way to get fresh scores on identical genomes
- **External monitoring** — `getState()` + `onMonitor` callback; no internal threads

---

## Technology Choices

| Choice | Decision | Rationale |
|---|---|---|
| Language | TypeScript | Aligns with pi ecosystem; type safety for callback contracts |
| Module format | ESM | Modern Node.js; no CommonJS interop noise |
| Build | `tsc --noEmit` for lint; `ts-node` for examples | No dist step until published as npm package |
| Test framework | None yet — examples serve as integration tests | Simple suite; `npm test` placeholder exists |
| No external deps | Node stdlib only (`crypto`, `fs`, `events`) | Zero-install promise |

---

## Features

### F-0001: Core EA lifecycle (DONE — v1.0.0)
seed → validate → evaluate → select → breed → repeat → terminate

### F-0002: Eval cache (DONE — v1.0.0)
SHA256 by genome content; `evalCacheEnabled` toggle

### F-0003: Parallel evaluation + backoff (DONE — v1.0.0)
Semaphore-controlled concurrency; exponential backoff with jitter

### F-0004: JSONL lineage logger (DONE — v1.0.0)
Append-only; machine-parseable; 10 event types

### F-0005: Rich type vocabulary (DONE — v1.1.0)
`RubricDim`, `Judgment`, `TrialResult`, `Gene*`, `GeneRegistry`, `benchmarkGate`

### F-0006: Schematic-first adapter (PENDING)
`BreedingStrategy` enum (9 strategies), `SchematicGenome`, `compile?` callback,
multi-generation parent pool — enables starlight-slm workflow

### F-0007: Heuristics module (PENDING)
`src/heuristics.ts` — cyclomatic complexity, type-hint coverage, docstring coverage
as composable `validate`/`evaluate` callbacks

### F-0008: Test suite (PENDING)
Vitest unit tests for: cache, backoff, semaphore, utils, EA lifecycle (mock evaluate)

### F-0009: Example parity (PENDING)
Examples 04–06: memory-config-evolution, research-arm-evolution, code-quality-evolution

### F-0010: npm publish readiness (PENDING)
`dist/` build, `exports` map with `types`, README badges, CHANGELOG
