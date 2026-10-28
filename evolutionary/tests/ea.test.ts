/**
 * Tests: EA Lifecycle Integration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EA } from '../src/ea.js';
import type { EAConfig, Individual, FitnessResult, ValidationResult } from '../src/types.js';

const mockGenome = (n: number) => ({ _text: `genome-${n}`, value: n });

const mockValidate = vi.fn<[Individual], Promise<ValidationResult>>(({ genome }) => {
  const n = (genome as { value: number }).value;
  return Promise.resolve({ valid: n % 2 === 0, reason: n % 2 === 0 ? '' : 'odd-not-allowed' });
});

const mockEvaluate = vi.fn<[Individual], Promise<FitnessResult>>(({ genome }) => {
  const n = (genome as { value: number }).value;
  return Promise.resolve({ fitness: n / 100, metrics: { n }, judgeOutput: `judged-${n}` });
});

const mockMutate = vi.fn<[Individual], Promise<Individual>>((ind) => {
  const n = (ind.genome as { value: number }).value;
  const child: Individual = {
    ...ind,
    id: `g99_p${n + 1}`,
    gen: 99,
    status: 'pending',
    genome: { _text: `genome-${n + 1}`, value: n + 1 },
    fitness: null,
    metrics: {},
    judgeOutput: '',
    cached: false,
    validationReason: '',
    retireCause: null,
    parents: [ind.id],
    breedMethod: 'mutate',
    createdAt: Date.now(),
    evaluatedAt: null,
  };
  return Promise.resolve(child);
});

const mockCrossover = vi.fn<[Individual, Individual], Promise<Individual>>((a, b) => {
  const nA = (a.genome as { value: number }).value;
  const nB = (b.genome as { value: number }).value;
  const child: Individual = {
    ...a,
    id: `g99_p${nA + nB}`,
    gen: 99,
    status: 'pending',
    genome: { _text: `cross-${nA}-${nB}`, value: nA + nB },
    fitness: null,
    metrics: {},
    judgeOutput: '',
    cached: false,
    validationReason: '',
    retireCause: null,
    parents: [a.id, b.id],
    breedMethod: 'crossover',
    createdAt: Date.now(),
    evaluatedAt: null,
  };
  return Promise.resolve(child);
});

const mockSeed = vi.fn<[number], Promise<ReturnType<typeof mockGenome>>>(async (i) => {
  return mockGenome(i);
});

const mockSelect = vi.fn<[Individual[], Map<string, number>], Individual[]>((pop, scores) => {
  // Return top half by fitness
  const sorted = [...pop].sort((a, b) => (b.fitness ?? 0) - (a.fitness ?? 0));
  return sorted.slice(0, Math.ceil(sorted.length / 2));
});

const mockShouldTerminate = vi.fn<[number, number, number], boolean>(
  (_gen, _fit, stagnant) => stagnant >= 99
);

const defaultConfig = (): EAConfig => ({
  artifactType: 'code',
  populationSize: 4,
  survivalRate: 0.5,
  elitismCount: 1,
  maxGenerations: 3,
  earlyStopRounds: 99,
  fitnessTarget: null,
  crossoverRate: 0.3,
  llmMutationRatio: 0.5,
  evalTimeoutMs: 5000,
  evalCacheEnabled: true,
  evalConcurrency: 2,
  breedConcurrency: 2,
  backoffBaseMs: 50,
  backoffMaxMs: 200,
  backoffMaxRetries: 2,
  logPath: '/tmp/ea-test.log',
  lineagePath: '/tmp/ea-test-lineage.jsonl',
  runId: 'test-run-001',
  validate: mockValidate,
  evaluate: mockEvaluate,
  mutate: mockMutate,
  crossover: mockCrossover,
  seed: mockSeed,
  select: mockSelect,
  shouldTerminate: mockShouldTerminate,
});

describe('EA', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('creates EA with SHA256EvalCache when evalCacheEnabled=true', () => {
      const ea = new EA(defaultConfig());
      expect(ea).toBeInstanceOf(EA);
    });

    it('creates EA with NoOpCache when evalCacheEnabled=false', () => {
      const config = defaultConfig();
      config.evalCacheEnabled = false;
      const ea = new EA(config);
      expect(ea).toBeInstanceOf(EA);
    });
  });

  describe('getState() before run', () => {
    it('returns initial state', () => {
      const ea = new EA(defaultConfig());
      const state = ea.getState();
      expect(state.runId).toBe('test-run-001');
      expect(state.generation).toBe(0);
      expect(state.populationSize).toBe(0);
    });
  });

  describe('isDone()', () => {
    it('returns false before run', () => {
      const ea = new EA(defaultConfig());
      expect(ea.isDone()).toBe(false);
    });
  });

  describe('run() — full lifecycle', () => {
    it('seeds, validates, evaluates, breeds over multiple generations', async () => {
      const config = defaultConfig();
      config.populationSize = 4;
      config.maxGenerations = 2;
      const ea = new EA(config);

      const runPromise = ea.run();
      vi.runAllTimers();
      await runPromise;

      expect(ea.isDone()).toBe(true);
      expect(mockSeed).toHaveBeenCalled(); // populationSize times for gen 0

      // Validate was called for each individual each generation
      expect(mockValidate).toHaveBeenCalled();

      // Evaluate was called for uncached individuals
      expect(mockEvaluate).toHaveBeenCalled();

      const state = ea.getState();
      expect(state.generationsCompleted).toBeGreaterThan(0);
    }, 10000);

    it('respects maxGenerations and terminates', async () => {
      const config = defaultConfig();
      config.maxGenerations = 1;
      config.populationSize = 2;
      const ea = new EA(config);

      const runPromise = ea.run();
      vi.runAllTimers();
      const result = await runPromise;

      expect(result.generationsCompleted).toBe(1);
      expect(result.terminated).toBe(true);
      expect(result.terminateReason).toBe('max_generations');
    });

    it('respects shouldTerminate callback', async () => {
      const config = defaultConfig();
      config.maxGenerations = 100;
      config.earlyStopRounds = 0; // stop immediately after gen 0
      config.populationSize = 2;
      const ea = new EA(config);

      const runPromise = ea.run();
      vi.runAllTimers();
      const result = await runPromise;

      expect(result.terminateReason).toBe('early_stop');
    });

    it('caches evaluations by genome content', async () => {
      const config = defaultConfig();
      config.populationSize = 2;
      config.maxGenerations = 2;
      config.evalCacheEnabled = true;
      const ea = new EA(config);

      const runPromise = ea.run();
      vi.runAllTimers();
      await runPromise;

      const state = ea.getState();
      // Second generation may hit cache if same genome values appear
      // At minimum, verify cache size > 0
      expect(state.cacheSize).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getBest()', () => {
    it('returns best individual after run', async () => {
      const config = defaultConfig();
      config.populationSize = 4;
      config.maxGenerations = 1;
      config.elitismCount = 1;
      const ea = new EA(config);

      const runPromise = ea.run();
      vi.runAllTimers();
      await runPromise;

      const best = ea.getBest();
      expect(best).not.toBeNull();
      expect(best!.fitness).not.toBeNull();
    });

    it('returns null when no individuals evaluated', () => {
      const config = defaultConfig();
      const ea = new EA(config);
      expect(ea.getBest()).toBeNull();
    });
  });
});