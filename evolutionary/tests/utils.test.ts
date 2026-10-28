/**
 * Tests: Utility Functions
 */

import { describe, it, expect } from 'vitest';
import {
  newId,
  createIndividual,
  safeConfig,
  ts,
  rouletteSelect,
  pickTwo,
  normalizeScore,
} from '../src/utils.js';
import type { Individual } from '../src/types.js';

describe('newId', () => {
  it('formats as g{gen}_p{index}', () => {
    expect(newId(0, 3)).toBe('g0_p3');
    expect(newId(5, 12)).toBe('g5_p12');
  });
});

describe('createIndividual', () => {
  it('creates individual with correct id, gen, status', () => {
    const ind = createIndividual(2, 5, { _text: 'hello' }, 'mutate', ['p1']);
    expect(ind.id).toBe('g2_p5');
    expect(ind.gen).toBe(2);
    expect(ind.status).toBe('pending');
    expect(ind.genome).toEqual({ _text: 'hello' });
    expect(ind.fitness).toBeNull();
    expect(ind.parents).toEqual(['p1']);
    expect(ind.breedMethod).toBe('mutate');
    expect(ind.cached).toBe(false);
    expect(ind.validationReason).toBe('');
    expect(ind.retireCause).toBeNull();
  });

  it('defaults parents to empty array', () => {
    const ind = createIndividual(0, 0, { _text: 'x' }, 'seed');
    expect(ind.parents).toEqual([]);
  });

  it('sets createdAt to current timestamp', () => {
    const before = Date.now();
    const ind = createIndividual(0, 0, { _text: 'x' }, 'seed');
    const after = Date.now();
    expect(ind.createdAt).toBeGreaterThanOrEqual(before);
    expect(ind.createdAt).toBeLessThanOrEqual(after);
    expect(ind.evaluatedAt).toBeNull();
  });
});

describe('safeConfig', () => {
  it('strips callback fields', () => {
    const config = {
      validate: () => Promise.resolve({ valid: true, reason: '' }),
      evaluate: () => Promise.resolve({ fitness: 1, metrics: {}, judgeOutput: '' }),
      mutate: () => Promise.resolve({} as Individual),
      crossover: () => Promise.resolve({} as Individual),
      seed: () => Promise.resolve({}),
      select: () => [],
      shouldTerminate: () => false,
      onRetire: () => Promise.resolve(),
      onGenerationEnd: () => Promise.resolve(),
      onMonitor: () => {},
      pop: 10,
      runId: 'abc',
    } as Record<string, unknown>;
    const safe = safeConfig(config);
    expect(safe).not.toHaveProperty('validate');
    expect(safe).not.toHaveProperty('evaluate');
    expect(safe).not.toHaveProperty('mutate');
    expect(safe).not.toHaveProperty('crossover');
    expect(safe).not.toHaveProperty('seed');
    expect(safe).not.toHaveProperty('select');
    expect(safe).not.toHaveProperty('shouldTerminate');
    expect(safe).not.toHaveProperty('onRetire');
    expect(safe).not.toHaveProperty('onGenerationEnd');
    expect(safe).not.toHaveProperty('onMonitor');
    expect(safe).toEqual({ pop: 10, runId: 'abc' });
  });
});

describe('ts', () => {
  it('returns an ISO timestamp string', () => {
    const result = ts();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
  });
});

describe('rouletteSelect', () => {
  const makeInd = (id: string, fitness: number): Individual =>
    ({ id } as Individual);

  it('returns the individual with highest fitness weight', () => {
    const pop = [makeInd('a', 0), makeInd('b', 0), makeInd('c', 10)];
    const scores = new Map([['a', 0], ['b', 0], ['c', 10]]);
    // With deterministic selection, highest weight always wins
    const result = rouletteSelect(pop, scores);
    expect(result.id).toBe('c');
  });

  it('returns random individual when all fitness is zero', () => {
    const pop = [makeInd('a', 0), makeInd('b', 0)];
    const scores = new Map([['a', 0], ['b', 0]]);
    // Should not throw and should return one of the individuals
    const result = rouletteSelect(pop, scores);
    expect(['a', 'b']).toContain(result.id);
  });

  it('returns last individual if random r lands past sum', () => {
    // This is a statistical test — we just verify it always returns from population
    const pop = [makeInd('a', 1), makeInd('b', 2)];
    const scores = new Map([['a', 1], ['b', 2]]);
    for (let i = 0; i < 20; i++) {
      const result = rouletteSelect(pop, scores);
      expect(['a', 'b']).toContain(result.id);
    }
  });
});

describe('pickTwo', () => {
  it('returns two elements from the array', () => {
    const arr = [1, 2, 3, 4, 5];
    const [a, b] = pickTwo(arr);
    expect(arr).toContain(a);
    expect(arr).toContain(b);
  });

  it('returns distinct elements when array has more than 1 item', () => {
    const arr = [1, 2, 3];
    const [a, b] = pickTwo(arr);
    expect(a).not.toBe(b);
  });

  it('handles array of length 1', () => {
    const arr = [42];
    const [a, b] = pickTwo(arr);
    expect(a).toBe(42);
    expect(b).toBe(42);
  });
});

describe('normalizeScore', () => {
  it('returns value in [0, 1] range', () => {
    expect(normalizeScore(50, 0, 100)).toBe(0.5);
    expect(normalizeScore(0, 0, 100)).toBe(0);
    expect(normalizeScore(100, 0, 100)).toBe(1);
  });

  it('clamps values outside range', () => {
    expect(normalizeScore(-10, 0, 100)).toBe(0);
    expect(normalizeScore(110, 0, 100)).toBe(1);
  });

  it('returns 0.5 when min equals max', () => {
    expect(normalizeScore(50, 50, 50)).toBe(0.5);
  });
});