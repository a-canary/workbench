# Ubiquitous Language — evolutionary

> Maintained by the Director. Suggestions via `/suggest-terminology` skill or the webUI Context browser.
> All code types, variable names, and documentation should use these canonical terms.

---

## Genome

**Definition:** The artifact being evolved — a tagged-union value (`_text`, `_yaml`, `_code`, `_tuple`, or free-form keys) that the framework treats as opaque; callers own all interpretation.

**Scope:** evolutionary

**Status:** canonical

---

## Individual

**Definition:** One variant in the living population at a given point in a run, carrying a genome, a fitness score (nullable until evaluated), a status, and full lineage metadata.

**Scope:** evolutionary

**Status:** canonical

---

## Population

**Definition:** The full set of `Individual` instances active in the current generation, sized by `populationSize`; replaced in part each generation via selection and breeding.

**Scope:** evolutionary

**Status:** canonical

---

## Generation

**Definition:** One complete cycle of validate → evaluate → select → breed; numbered from 0 (seed generation) and tracked on every `Individual` via `ind.gen`.

**Scope:** evolutionary

**Status:** canonical

---

## Fitness

**Definition:** A scalar in `[0, 1]` assigned to an `Individual` after evaluation; `null` while pending or invalid; the sole currency of selection and breeding decisions.

**Scope:** evolutionary

**Status:** canonical

---

## RubricDim

**Definition:** A named sub-score within a multi-dimensional evaluation judgment (e.g., `{ technical_accuracy: 0.85, task_relevance: 0.9 }`); multiple dimensions are aggregated into a single `overall` fitness via the `evaluate` callback.

**Aliases:** rubric dimension

**Scope:** evolutionary

**Status:** canonical

---

## Judgment

**Definition:** The raw output from one evaluation judge call — contains a `RubricDim` map, an `overall` composite score, the judge model name, reasoning text, and a timestamp; one `TrialResult` wraps one `Judgment`.

**Scope:** evolutionary

**Status:** canonical

---

## TrialResult

**Definition:** The result of evaluating one `Individual` against one task: pairs a `Judgment` with latency, optional cost, and a `cached` flag indicating whether the score was served from the eval cache.

**Scope:** evolutionary

**Status:** canonical

---

## ArtifactType

**Definition:** A discriminant tag that classifies what a genome represents — one of `free-text`, `structured-text`, `code`, `config-tuple`, `pipeline`, or `concept`; declared in `EAConfig.artifactType` and used to guide callback implementations.

**Scope:** evolutionary

**Status:** canonical

---

## Gene

**Definition:** A named, typed dimension of a config-tuple genome: `GeneBool`, `GeneCategorical`, or `GeneFloat`; genes express the search space as discrete typed slots rather than freeform text.

**Scope:** evolutionary

**Status:** canonical

---

## GeneRegistry

**Definition:** A named collection of `GeneAny` definitions that fully describes the config space for a config-tuple genome; `applyGeneRegistry` maps a parallel array of values onto a `Genome` by gene name.

**Scope:** evolutionary

**Status:** canonical

---

## SchematicGenome

**Definition:** A structured variant of `Genome` whose `_schematic` key holds an array of named `SchematicSection`s, each containing `SchematicField`s with explicit `mutationWeight` annotations; unlike `Genome._yaml`, this structure is understood and operated on by the schematic-first adapter.

**Scope:** evolutionary

**Status:** canonical

---

## BreedingStrategy

**Definition:** An enum of nine schematic-level mutation and crossover operations (`SMALL_MUTATION`, `LARGE_MUTATION`, `FEATURE_CROSSOVER`, `ABSTRACT`, `INSTANTIATE`, `SINGLE_POINT_CROSSOVER`, `SHUFFLE`, `INNOVATION`, `SIMPLIFY`) applied by the schematic-first adapter to produce offspring schematics.

**Scope:** evolutionary

**Status:** canonical

---

## Compile

**Definition:** The callback (`SchematicEAConfig.compile`) that translates a `SchematicGenome` into an executable `Genome` artifact (e.g., `model.py`, `config.yaml`); the bridge between the lightweight schematic the EA evolves and the heavier artifact the evaluator scores.

**Scope:** evolutionary

**Status:** canonical

---

## ParentPool

**Definition:** A cross-generation buffer of elite `Individual`s maintained by the schematic-first adapter; drawn from the last N evaluated generations weighted by fitness and recency, so strong genetic material survives even when direct descendants are not selected.

**Scope:** evolutionary

**Status:** canonical

---

## Seed

**Definition:** The `breedMethod` value and lifecycle phase that initializes generation 0 by calling `EAConfig.seed(index)` once per population slot; seeded individuals have no parents and carry `breedMethod: 'seed'`.

**Scope:** evolutionary

**Status:** canonical

---

## Mutation

**Definition:** A breeding operation that produces one offspring from one parent by modifying the parent genome; activated when `Math.random() >= crossoverRate` or when only one survivor exists; implemented by `EAConfig.mutate`.

**Scope:** evolutionary

**Status:** canonical

---

## Crossover

**Definition:** A breeding operation that combines two parent individuals into one offspring; activated when `Math.random() < crossoverRate` and at least two survivors exist; implemented by `EAConfig.crossover`.

**Scope:** evolutionary

**Status:** canonical

---

## Selection

**Definition:** The phase that partitions the evaluated population into survivors and casualties each generation; elites are always kept; the remainder is chosen via the `EAConfig.select` callback (e.g., roulette-wheel or tournament).

**Scope:** evolutionary

**Status:** canonical

---

## Retire

**Definition:** The act of removing an `Individual` from the living population with a `RetireCause` (`low-fitness`, `validation-fail`, `timeout`, `error`, or `manual`); triggers the `onRetire` hook so callers decide whether to archive, promote, or discard the artifact.

**Scope:** evolutionary

**Status:** canonical

---

## EvalCache

**Definition:** An in-memory SHA256-keyed store (keyed on sorted-JSON serialization of the genome) that returns a `FitnessResult` for any genome seen before in the current run; skipped entirely when `evalCacheEnabled: false`.

**Aliases:** eval cache, SHA256 eval cache

**Scope:** evolutionary

**Status:** canonical

---

## Backoff

**Definition:** The `withBackoff` retry wrapper used around every `evaluate` call; applies exponential delay doubling with ±10% jitter between attempts to prevent thundering-herd retries when LLM rate limits or transient network errors occur.

**Aliases:** exponential backoff

**Scope:** evolutionary

**Status:** canonical

---

## Semaphore

**Definition:** A FIFO-queued concurrency limiter that caps simultaneous operations; two independent semaphores control `evalConcurrency` (parallel evaluations) and `breedConcurrency` (parallel breeding calls).

**Scope:** evolutionary

**Status:** canonical

---

## LineageLogger

**Definition:** The append-only JSONL writer that records every lifecycle event (`run_start`, `seed`, `validate`, `evaluate`, `generation_end`, `select`, `retire`, `bred`, `terminate`, `run_end`) as a single-line JSON object keyed by `type` and `run_id`.

**Aliases:** lineage log, JSONL logger

**Scope:** evolutionary

**Status:** canonical

---

## BenchmarkGate

**Definition:** An optional fast smoke-test callback (`EAConfig.benchmarkGate`) that an `Individual` must pass before entering expensive evaluation; used to prevent evolved configs from regressing on established baselines without paying full eval cost.

**Scope:** evolutionary

**Status:** canonical

---

## StagnantRounds

**Definition:** A counter incremented each generation in which `bestFitness` does not improve; passed to `EAConfig.shouldTerminate` to trigger early stopping when the population has converged.

**Aliases:** stagnant rounds, stagnancy counter

**Scope:** evolutionary

**Status:** canonical

---

## EvalMethod

**Definition:** A discriminant tag on evaluation strategy — one of `pass-rate`, `metric`, `llm-judge-rubric`, `llm-judge-pairwise`, or `human-oracle`; documents the expected contract of the `evaluate` callback without being enforced by the framework.

**Scope:** evolutionary

**Status:** canonical

---
