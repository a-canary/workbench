/**
 * Tests: SHA256 Eval Cache
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SHA256EvalCache, NoOpCache, type EvalCache } from '../src/cache.js';
import type { FitnessResult, Genome } from '../src/types.js';

const mockResult = (n: number): FitnessResult => ({
  fitness: n,
  metrics: { latencyMs: n * 10 },
  judgeOutput: `output-${n}`,
});

describe('SHA256EvalCache', () => {
  let cache: SHA256EvalCache;

  beforeEach(() => {
    cache = new SHA256EvalCache();
  });

  it('stores and retrieves a result', () => {
    const genome: Genome = { _text: 'hello world' };
    cache.set(genome, mockResult(0.9));
    const result = cache.get(genome);
    expect(result).toEqual(mockResult(0.9));
  });

  it('returns null for missing key', () => {
    const result = cache.get({ _text: 'not stored' });
    expect(result).toBeNull();
  });

  it('is deterministic: identical genomes get same hash', () => {
    const g1: Genome = { _text: 'same content' };
    const g2: Genome = { _text: 'same content' };
    cache.set(g1, mockResult(0.5));
    expect(cache.get(g2)).toEqual(mockResult(0.5));
  });

  it('key order does not affect hash (sorted keys)', () => {
    const g1: Genome = { _text: 'x', _yaml: { b: 2, a: 1 } };
    const g2: Genome = { _yaml: { a: 1, b: 2 }, _text: 'x' };
    cache.set(g1, mockResult(0.7));
    expect(cache.get(g2)).toEqual(mockResult(0.7));
  });

  it('different genomes produce different results', () => {
    cache.set({ _text: 'a' }, mockResult(1.0));
    cache.set({ _text: 'b' }, mockResult(0.5));
    expect(cache.get({ _text: 'a' })).toEqual(mockResult(1.0));
    expect(cache.get({ _text: 'b' })).toEqual(mockResult(0.5));
    expect(cache.get({ _text: 'c' })).toBeNull();
  });

  it('clear() removes all entries', () => {
    cache.set({ _text: 'a' }, mockResult(1.0));
    cache.set({ _text: 'b' }, mockResult(0.5));
    cache.clear();
    expect(cache.get({ _text: 'a' })).toBeNull();
    expect(cache.get({ _text: 'b' })).toBeNull();
    expect(cache.size()).toBe(0);
  });

  it('size() returns entry count', () => {
    expect(cache.size()).toBe(0);
    cache.set({ _text: 'a' }, mockResult(1.0));
    cache.set({ _text: 'b' }, mockResult(0.5));
    expect(cache.size()).toBe(2);
  });
});

describe('NoOpCache', () => {
  let cache: NoOpCache;

  beforeEach(() => {
    cache = new NoOpCache();
  });

  it('get() always returns null', () => {
    expect(cache.get({ _text: 'anything' })).toBeNull();
  });

  it('set() is a no-op (no throw)', () => {
    expect(() => cache.set({ _text: 'x' }, mockResult(1.0))).not.toThrow();
  });

  it('clear() is a no-op', () => {
    expect(() => cache.clear()).not.toThrow();
  });

  it('size() always returns 0', () => {
    expect(cache.size()).toBe(0);
  });
});