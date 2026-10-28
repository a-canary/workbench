/**
 * EA Orchestrator
 *
 * Implements the full EA lifecycle:
 *   seed → validate → evaluate → select → breed → repeat → terminate
 *
 * Provides:
 * - Parallel evaluation with configurable concurrency (Semaphore)
 * - Exponential backoff with jitter on transient eval failures
 * - SHA256 eval cache by genome content (not individual ID)
 * - Append-only JSONL lineage log
 * - Event hooks: agent controls artifact lifecycle (onRetire) and monitoring
 *
 * The agent drives monitoring externally via getState() polling.
 * Long runs should be run via Hermes cron, not a single CLI invocation.
 */

import { EventEmitter } from 'events';
import { SHA256EvalCache, NoOpCache, type EvalCache } from './cache.js';
import { LineageLogger } from './logger.js';
import { withBackoff } from './backoff.js';
import { Semaphore } from './semaphore.js';
import {
  newId,
  createIndividual,
  safeConfig,
  ts,
  rouletteSelect,
  pickTwo,
} from './utils.js';
import type {
  EAConfig,
  Individual,
  EARunState,
  EARunResult,
  RetireCause,
} from './types.js';

export class EA extends EventEmitter {
  private population: Individual[] = [];
  private bestFitness = 0;
  private stagnantRounds = 0;
  private generation = 0;
  private totalEvaluations = 0;
  private totalCacheHits = 0;
  private cache: EvalCache;
  private logger: LineageLogger;
  private terminated = false;
  private terminateReason = '';

  constructor(private config: EAConfig) {
    super();
    this.cache = config.evalCacheEnabled
      ? new SHA256EvalCache()
      : new NoOpCache();
    this.logger = new LineageLogger(config.logPath);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Run the full EA.
   *
   * May take hours. For long-running EAs, prefer Hermes cron:
   *   const state = ea.getState();   // poll every N seconds
   *   if (ea.isDone()) { ... }       // check completion
   */
  async run(): Promise<EARunResult> {
    this.log({ type: 'run_start', run_id: this.config.runId, ts: ts(), params: safeConfig(this.config as unknown as Record<string, unknown>) });

    try {
      // ── Generation 0: seed all ──────────────────────────────────────────
      this.population = await this.parallelSeed();
      await this.evaluateGeneration();

      // ── Evolution loop ─────────────────────────────────────────────────
      while (!this.terminated) {
        this.generation++;

        if (this.config.shouldTerminate(this.generation, this.bestFitness, this.stagnantRounds)) {
          this.terminateEA('early_stop');
          break;
        }
        if (this.generation >= this.config.maxGenerations) {
          this.terminateEA('max_generations');
          break;
        }

        // ── Select survivors ──────────────────────────────────────────────
        const { survivors, casualties } = this.selectSurvivors();

        // ── Retire casualties — agent decides artifact lifecycle ──────────
        for (const casualty of casualties) {
          this.retire(casualty, 'low-fitness');
        }

        // ── Breed replacements in parallel ───────────────────────────────
        const replacements = await this.parallelBreed(casualties.length, survivors);

        // ── Build next population ──────────────────────────────────────────
        this.population = [...survivors, ...replacements];

        // ── Evaluate next generation ───────────────────────────────────────
        await this.evaluateGeneration();
      }
    } finally {
      this.logger.log({ type: 'run_end', run_id: this.config.runId, ts: ts() });
      this.logger.close();
    }

    return this.buildResult();
  }

  /** Current state for monitor polling */
  getState(): EARunState {
    const evaluated = this.population.filter(i => i.status === 'evaluated');
    const cacheHitRate = this.totalEvaluations > 0 ? this.totalCacheHits / this.totalEvaluations : 0;
    return {
      runId: this.config.runId,
      generation: this.generation,
      generationsCompleted: this.generation,
      populationSize: this.population.length,
      evaluatedCount: evaluated.length,
      retiredCount: this.population.filter(i => i.status === 'retired').length,
      bestFitness: this.bestFitness,
      meanFitness: evaluated.length > 0
        ? evaluated.reduce((s, i) => s + (i.fitness ?? 0), 0) / evaluated.length
        : 0,
      stagnantRounds: this.stagnantRounds,
      totalEvaluations: this.totalEvaluations,
      cacheHitRate,
      cacheSize: this.cache.size(),
    };
  }

  /** True once run has finished (terminate() called) */
  isDone(): boolean {
    return this.terminated;
  }

  /** Best evaluated individual, or null if none */
  getBest(): Individual | null {
    const evaluated = this.population.filter(i => i.status === 'evaluated' && i.fitness !== null);
    if (evaluated.length === 0) return null;
    return evaluated.reduce((best, ind) =>
      (ind.fitness ?? -Infinity) > (best.fitness ?? -Infinity) ? ind : best
    );
  }

  // ---------------------------------------------------------------------------
  // Phase 1: Seed — parallel, all at once
  // ---------------------------------------------------------------------------

  private async parallelSeed(): Promise<Individual[]> {
    const promises = Array.from(
      { length: this.config.populationSize },
      async (_, i) => {
        const genome = await this.config.seed(i);
        return createIndividual(0, i, genome, 'seed');
      }
    );

    const results = await Promise.allSettled(promises);
    const individuals: Individual[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        individuals.push(result.value);
        this.log({ type: 'seed', run_id: this.config.runId, gen: 0, id: result.value.id, breed: 'seed', parents: [], ts: ts() });
      } else {
        console.error(`Seed ${i} failed:`, result.reason);
      }
    }

    return individuals;
  }

  // ---------------------------------------------------------------------------
  // Phase 2: Validate + Evaluate
  // ---------------------------------------------------------------------------

  private async evaluateGeneration(): Promise<void> {
    // ── Validate all first (cheap gate — skip eval cost for invalids) ───────
    await this.validateAll();

    // ── Partition: cached vs uncached ───────────────────────────────────────
    const uncached: Individual[] = [];

    for (const ind of this.population) {
      if (ind.status !== 'valid') continue;

      const cached = this.cache.get(ind.genome);
      if (cached) {
        ind.fitness = cached.fitness;
        ind.metrics = cached.metrics;
        ind.judgeOutput = cached.judgeOutput;
        ind.cached = true;
        ind.status = 'evaluated';
        ind.evaluatedAt = Date.now();
        this.totalCacheHits++;
        this.totalEvaluations++;
        this.logEval(ind);
      } else {
        uncached.push(ind);
      }
    }

    // ── Evaluate uncached in parallel with concurrency limit + backoff ───────
    await this.parallelEvaluate(uncached);

    // ── Post-generation bookkeeping ─────────────────────────────────────────
    const evaluated = this.population.filter(i => i.status === 'evaluated' && i.fitness !== null);
    const best = this.getBest();
    const mean = evaluated.length > 0
      ? evaluated.reduce((s, i) => s + (i.fitness ?? 0), 0) / evaluated.length
      : 0;

    if (best && best.fitness !== null && best.fitness > this.bestFitness) {
      this.bestFitness = best.fitness;
      this.stagnantRounds = 0;
    } else {
      this.stagnantRounds++;
    }

    this.logger.log({
      type: 'generation_end',
      run_id: this.config.runId,
      gen: this.generation,
      best_id: best?.id ?? null,
      best_fitness: best?.fitness ?? null,
      mean,
      pop_size: this.population.length,
      invalid_count: this.population.filter(i => i.status === 'invalid').length,
      cache_hit_rate: this.totalEvaluations > 0 ? this.totalCacheHits / this.totalEvaluations : 0,
      ts: ts(),
    });

    await this.config.onGenerationEnd?.(this.generation, best, mean);
    this.config.onMonitor?.(this.getState());
  }

  private async validateAll(): Promise<void> {
    await Promise.all(
      this.population.map(async (ind) => {
        ind.status = 'validating';
        const result = await this.config.validate(ind);
        ind.status = result.valid ? 'valid' : 'invalid';
        ind.validationReason = result.reason;
        this.log({
          type: 'validate',
          run_id: this.config.runId,
          gen: this.generation,
          id: ind.id,
          valid: result.valid,
          reason: result.reason,
          ts: ts(),
        });
      })
    );
  }

  private async parallelEvaluate(individuals: Individual[]): Promise<void> {
    const sem = new Semaphore(this.config.evalConcurrency);

    const promises = individuals.map(async (ind): Promise<void> => {
      await sem.acquire();
      try {
        const result = await withBackoff(
          () => this.config.evaluate(ind),
          {
            baseMs: this.config.backoffBaseMs,
            maxMs: this.config.backoffMaxMs,
            maxRetries: this.config.backoffMaxRetries,
            onRetry: (attempt, delayMs, err) => {
              console.warn(`[${ind.id}] eval retry ${attempt} after ${Math.round(delayMs)}ms: ${err}`);
              this.emit('eval_retry', { individual: ind, attempt, delayMs, error: err });
            },
          }
        );

        ind.fitness = result.fitness;
        ind.metrics = result.metrics;
        ind.judgeOutput = result.judgeOutput;
        ind.cached = false;
        ind.status = 'evaluated';
        ind.evaluatedAt = Date.now();

        this.cache.set(ind.genome, result);
        this.totalEvaluations++;

        this.logEval(ind);
      } catch (err) {
        console.error(`[${ind.id}] eval failed:`, err);
        ind.status = 'invalid';
        ind.validationReason = `eval_error: ${err}`;
        this.log({
          type: 'validate',
          run_id: this.config.runId,
          gen: this.generation,
          id: ind.id,
          valid: false,
          reason: `eval_error: ${err}`,
          ts: ts(),
        });
      } finally {
        sem.release();
      }
    });

    await Promise.all(promises);
  }

  // ---------------------------------------------------------------------------
  // Phase 3: Select — elitism + config-provided selection method
  // ---------------------------------------------------------------------------

  private selectSurvivors(): { survivors: Individual[]; casualties: Individual[] } {
    const evaluated = this.population.filter(i => i.status === 'evaluated' && i.fitness !== null);
    const fitnessScores = new Map<string, number>(evaluated.map(i => [i.id, i.fitness!]));

    // Always-keep elite
    const elite = [...evaluated]
      .sort((a, b) => b.fitness! - a.fitness!)
      .slice(0, this.config.elitismCount);

    // Non-elite evaluated candidates
    const nonElite = evaluated.filter(i => !elite.find(e => e.id === i.id));

    // Config-provided selection
    const selected = this.config.select(nonElite, fitnessScores);

    // Merge elite + selected, dedup by id
    const survivorIds = new Set<string>();
    for (const e of elite)   survivorIds.add(e.id);
    for (const s of selected) survivorIds.add(s.id);

    const survivors = this.population.filter(i => survivorIds.has(i.id));
    const casualties = this.population.filter(i => !survivorIds.has(i.id));

    this.logger.log({
      type: 'select',
      run_id: this.config.runId,
      gen: this.generation,
      survivors: survivors.map(s => s.id),
      casualties: casualties.map(c => c.id),
      ts: ts(),
    });

    return { survivors, casualties };
  }

  // ---------------------------------------------------------------------------
  // Phase 4: Breed — parallel with concurrency limit
  // ---------------------------------------------------------------------------

  private async parallelBreed(count: number, survivors: Individual[]): Promise<Individual[]> {
    if (count === 0) return [];

    const sem = new Semaphore(this.config.breedConcurrency);
    const baseIndex = this.population.filter(i => i.status !== 'retired').length;

    const promises = Array.from({ length: count }, async (_, i): Promise<Individual | null> => {
      await sem.acquire();
      try {
        if (survivors.length === 0) {
          return null;
        }
        const useCrossover = Math.random() < this.config.crossoverRate && survivors.length >= 2;
        let child: Individual;

        if (useCrossover) {
          const [a, b] = pickTwo(survivors);
          if (!a || !b) return null;
          child = await this.config.crossover(a, b);
          child.breedMethod = 'crossover';
          child.parents = [a.id, b.id];
        } else {
          const parent = rouletteSelect(survivors, new Map(survivors.map(s => [s.id, s.fitness ?? 0])));
          if (!parent) return null;
          child = await this.config.mutate(parent);
          child.breedMethod = 'mutate';
          child.parents = [parent.id];
        }

        child.id = newId(this.generation, baseIndex + i);
        child.gen = this.generation;
        child.createdAt = Date.now();

        this.log({ type: 'bred', run_id: this.config.runId, gen: this.generation, id: child.id, breed: child.breedMethod, parents: child.parents, ts: ts() });
        return child;
      } catch (err) {
        console.error('Breed failed:', err);
        return null;
      } finally {
        sem.release();
      }
    });

    const results = await Promise.all(promises);
    return results.filter((c): c is Individual => c !== null);
  }

  // ---------------------------------------------------------------------------
  // Retire — agent controls artifact lifecycle
  // ---------------------------------------------------------------------------

  private retire(ind: Individual, cause: RetireCause): void {
    ind.status = 'retired';
    ind.retireCause = cause;

    this.logger.log({
      type: 'retire',
      run_id: this.config.runId,
      gen: this.generation,
      id: ind.id,
      cause,
      fitness: ind.fitness,
      archived: true,
      ts: ts(),
    });

    // The EA stops referencing this individual.
    // The agent decides what happens to the artifact:
    //   - best-ever: save before retiring anything
    //   - keep_lineage: archive to disk
    //   - cause in [validation-fail, error, timeout]: failed corpus
    //   - else: discard (free disk/memory)
    //
    // The onRetire hook is the agent's decision point.
    this.config.onRetire?.(ind, cause).catch(err =>
      console.error(`onRetire hook error for ${ind.id}:`, err)
    );
  }

  // ---------------------------------------------------------------------------
  // Terminate
  // ---------------------------------------------------------------------------

  private terminateEA(reason: string): void {
    this.terminated = true;
    this.terminateReason = reason;

    const best = this.getBest();

    this.logger.log({
      type: 'terminate',
      run_id: this.config.runId,
      gen: this.generation,
      reason,
      best_id: best?.id ?? null,
      best_fitness: best?.fitness ?? null,
      ts: ts(),
    });

    this.emit('terminate', { reason, best });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private logEval(ind: Individual): void {
    this.logger.log({
      type: 'evaluate',
      run_id: this.config.runId,
      gen: ind.gen,
      id: ind.id,
      fitness: ind.fitness,
      cached: ind.cached,
      metrics: ind.metrics,
      ts: ts(),
    });
  }

  private buildResult(): EARunResult {
    const best = this.getBest();
    return {
      runId: this.config.runId,
      generationsCompleted: this.generation,
      bestIndividual: best!,
      bestFitness: best?.fitness ?? 0,
      totalEvaluations: this.totalEvaluations,
      cacheHitRate: this.totalEvaluations > 0 ? this.totalCacheHits / this.totalEvaluations : 0,
      terminated: this.terminated,
      terminateReason: this.terminateReason,
    };
  }

  private log(event: Parameters<typeof this.logger.log>[0]): void {
    this.logger.log(event);
  }
}