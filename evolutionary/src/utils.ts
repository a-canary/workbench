/**
 * Utilities — ID generation, individual factory, helpers
 */

import type { Individual, Genome } from './types.js';

/**
 * Generate a stable individual ID from generation + population index.
 * Format: g{gen}_p{index}  e.g.  g0_p3, g5_p12
 */
export function newId(gen: number, index: number): string {
  return `g${gen}_p${index}`;
}

/**
 * Factory: create a fresh Individual with defaults set.
 */
export function createIndividual(
  gen: number,
  index: number,
  genome: Genome,
  breedMethod: 'seed' | 'mutate' | 'crossover',
  parents: string[] = []
): Individual {
  return {
    id: newId(gen, index),
    gen,
    status: 'pending',
    genome,
    fitness: null,
    metrics: {},
    judgeOutput: '',
    cached: false,
    validationReason: '',
    retireCause: null,
    parents,
    breedMethod,
    createdAt: Date.now(),
    evaluatedAt: null,
  };
}

/** Strip callbacks from a config object before logging (not serializable) */
export function safeConfig(config: Record<string, unknown>): Record<string, unknown> {
  const {
    validate, evaluate, mutate, crossover, seed, select, shouldTerminate,
    onRetire, onGenerationEnd, onMonitor,
    ...rest
  } = config;
  return rest;
}

/** ISO timestamp */
export function ts(): string {
  return new Date().toISOString();
}

/** Roulette-wheel (fitness-proportionate) selection */
export function rouletteSelect(population: Individual[], fitnessScores: Map<string, number>): Individual {
  const total = population.reduce((s, i) => s + (fitnessScores.get(i.id) ?? 0), 0);
  if (total === 0) return population[Math.floor(Math.random() * population.length)];
  let r = Math.random() * total;
  for (const ind of population) {
    r -= fitnessScores.get(ind.id) ?? 0;
    if (r <= 0) return ind;
  }
  return population[population.length - 1];
}

/** Pick two distinct individuals from population */
export function pickTwo<T>(population: T[]): [T, T] {
  const a = population[Math.floor(Math.random() * population.length)];
  let b = population[Math.floor(Math.random() * population.length)];
  while (b === a && population.length > 1) {
    b = population[Math.floor(Math.random() * population.length)];
  }
  return [a, b];
}

/** Normalize a score to [0, 1]. If all zero or empty, returns 0.5. */
export function normalizeScore(score: number, min: number, max: number): number {
  if (max === min) return 0.5;
  return Math.max(0, Math.min(1, (score - min) / (max - min)));
}