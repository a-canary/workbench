/**
 * Example 02 — Config Tuple Evolution
 *
 * Evolves a 6-dimension memory strategy config (D1–D6) using:
 *   - Dim-flip mutation at specific dimensions
 *   - Single-point crossover on the 6-element tuple
 *   - Programmatic fitness (simulated: prefers D1=D3, penalizes D5=cold)
 *
 * Demonstrates:
 * - config-tuple artifact type
 * - Single-point crossover on fixed-length arrays
 * - Weighted dim-flip mutation (D1/D3 have higher mutation weight)
 * - Validation gate: enum membership + mutual exclusivity check
 *
 * Run: npx ts-node examples/02-config-evolution.ts
 */

import { EA, EAConfig, Individual, RetireCause } from '../src/index.js';
import type { Genome } from '../src/index.js';

// =============================================================================
// Domain Constants
// =============================================================================

const D1_OPTIONS = ['dynamic', 'static', 'semantic'] as const;
const D2_OPTIONS = ['LRU', 'LFU', 'FIFO'] as const;
const D3_OPTIONS = ['embed', 'exact', 'hybrid'] as const;
const D4_OPTIONS = ['no-ledge', 'full-ledge'] as const;
const D5_OPTIONS = ['cold', 'warm', 'hot'] as const;
const D6_OPTIONS = ['1h', '6h', '24h'] as const;

type ConfigTuple = [string, string, string, string, string, string];

function randomTuple(): ConfigTuple {
  return [
    D1_OPTIONS[Math.floor(Math.random() * D1_OPTIONS.length)],
    D2_OPTIONS[Math.floor(Math.random() * D2_OPTIONS.length)],
    D3_OPTIONS[Math.floor(Math.random() * D3_OPTIONS.length)],
    D4_OPTIONS[Math.floor(Math.random() * D4_OPTIONS.length)],
    D5_OPTIONS[Math.floor(Math.random() * D5_OPTIONS.length)],
    D6_OPTIONS[Math.floor(Math.random() * D6_OPTIONS.length)],
  ];
}

// =============================================================================
// Callbacks
// =============================================================================

/** Validation: each dimension in its allowed set; D4+D5 mutual exclusivity */
async function validate(ind: Individual): Promise<{ valid: boolean; reason: string }> {
  const tuple = (ind.genome._tuple ?? []) as string[];

  const D_OPTIONS: (readonly string[])[] = [D1_OPTIONS, D2_OPTIONS, D3_OPTIONS, D4_OPTIONS, D5_OPTIONS, D6_OPTIONS];
  for (let i = 0; i < 6; i++) {
    if (!D_OPTIONS[i].includes(tuple[i])) {
      return { valid: false, reason: `dim${i + 1}="${tuple[i]}" not in allowed set` };
    }
  }
  // D4=no-ledge and D5=warm are mutually exclusive (simulated constraint)
  if (tuple[3] === 'no-ledge' && tuple[4] === 'warm') {
    return { valid: false, reason: 'D4=no-ledge and D5=warm are mutually exclusive' };
  }
  return { valid: true, reason: '' };
}

/** Evaluation: simulated fitness — rewards D1=D3=hybrid, penalizes D5=cold */
async function evaluate(ind: Individual) {
  await sleep(20 + Math.random() * 30);

  const tuple = (ind.genome._tuple ?? []) as string[];
  let score = 0.5;

  // Bonus: D1 and D3 both "hybrid"
  if (tuple[0] === 'hybrid' && tuple[2] === 'hybrid') score += 0.25;
  // Penalty: D5=cold (high latency)
  if (tuple[4] === 'cold') score -= 0.2;
  // Bonus: D6=24h (high TTL = less churn)
  if (tuple[5] === '24h') score += 0.1;
  // Bonus: D2=LFU (frequency-based is often best)
  if (tuple[1] === 'LFU') score += 0.1;
  // Small random noise to differentiate same-score configs
  score += (Math.random() - 0.5) * 0.05;

  score = Math.max(0, Math.min(1, score));

  return {
    fitness: Math.round(score * 100) / 100,
    metrics: { tuple, D1: tuple[0], D2: tuple[1] },
    judgeOutput: `D1=${tuple[0]} D2=${tuple[1]} D3=${tuple[2]} D4=${tuple[3]} D5=${tuple[4]} D6=${tuple[5]}`,
  };
}

/** Mutation: dim-flip — pick 1-2 dimensions, weighted toward D1/D3 */
async function mutate(parent: Individual): Promise<Individual> {
  const tuple = [...((parent.genome._tuple as string[]) ?? randomTuple())] as string[];
  const dimOptions = [D1_OPTIONS, D2_OPTIONS, D3_OPTIONS, D4_OPTIONS, D5_OPTIONS, D6_OPTIONS];
  // D1 and D3 have 2x mutation weight
  const weights = [2, 1, 2, 1, 1, 1];
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const mutateCount = Math.random() < 0.7 ? 1 : 2;
  const mutated = new Set<number>();

  for (let m = 0; m < mutateCount; m++) {
    let r = Math.random() * totalWeight;
    let dim = 0;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) { dim = i; break; }
    }
    if (mutated.has(dim)) continue;
    mutated.add(dim);

    // Pick a different option from current
    const current = tuple[dim];
    const options = [...dimOptions[dim]];
    const newVal = options.filter(o => o !== current)[Math.floor(Math.random() * (options.length - 1))];
    tuple[dim] = newVal;
  }

  return { ...parent, genome: { ...parent.genome, _tuple: tuple } };
}

/** Crossover: single-point on 6-element tuple */
async function crossover(a: Individual, b: Individual): Promise<Individual> {
  const tupleA = (a.genome._tuple ?? []) as string[];
  const tupleB = (b.genome._tuple ?? []) as string[];

  // Single-point: pick split, take [0..point) from A, [point..end) from B
  const point = 1 + Math.floor(Math.random() * (tupleA.length - 1));
  const newTuple = [...tupleA.slice(0, point), ...tupleB.slice(point)];

  return {
    ...a,
    genome: { ...a.genome, _tuple: newTuple },
    parents: [a.id, b.id],
  };
}

/** Seed: 8 random valid tuples */
async function seed(_index: number): Promise<Genome> {
  return { _tuple: randomTuple() };
}

/** Rank-based selection */
function select(population: Individual[], scores: Map<string, number>): Individual[] {
  return [...population]
    .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0))
    .slice(0, Math.max(1, Math.floor(population.length * 0.5)));
}

/** Early stop: 5 stagnant generations */
function shouldTerminate(_gen: number, _best: number, stagnant: number): boolean {
  return stagnant >= 5;
}

// =============================================================================
// Agent lifecycle
// =============================================================================

let bestEver: Individual | null = null;

async function onRetire(ind: Individual, _cause: RetireCause): Promise<void> {
  if (!bestEver || (ind.fitness ?? 0) > (bestEver.fitness ?? 0)) {
    bestEver = { ...ind };
    const t = (ind.genome._tuple as string[]);
    console.log(`  ★ ${ind.id} fitness=${ind.fitness} → [${t.join(', ')}]`);
  }
}

// =============================================================================
// Monitor
// =============================================================================

function startMonitor(ea: EA): () => void {
  const id = setInterval(() => {
    if (ea.isDone()) { clearInterval(id); return; }
    const s = ea.getState();
    const best = ea.getBest();
    const tuple = best ? (best.genome._tuple as string[]) : null;
    console.log(
      `  gen=${String(s.generation).padStart(2)} eval=${s.evaluatedCount}/${s.populationSize} ` +
      `best=${s.bestFitness.toFixed(3)} stale=${s.stagnantRounds} ` +
      (tuple ? `best_config=[${tuple.join(', ')}]` : '')
    );
  }, 2000);
  return () => clearInterval(id);
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log('\n=== Example 02: Config Tuple Evolution ===\n');
  console.log('Evolving 6-dim memory strategy: D1=dynamic/static/semantic, D2=LRU/LFU/FIFO,');
  console.log('D3=embed/exact/hybrid, D4=no-ledge/full-ledge, D5=cold/warm/hot, D6=1h/6h/24h\n');

  const runId = `config_ea_${Date.now().toString(36)}`;
  const logPath = `/tmp/${runId}/lineage.jsonl`;

  const config: EAConfig = {
    artifactType: 'config-tuple',
    populationSize: 8,
    survivalRate: 0.5,
    elitismCount: 1,
    maxGenerations: 20,
    earlyStopRounds: 5,
    fitnessTarget: null,
    crossoverRate: 0.8,
    llmMutationRatio: 0,
    evalTimeoutMs: 30_000,
    evalCacheEnabled: true,
    evalConcurrency: 4,
    breedConcurrency: 4,
    backoffBaseMs: 500,
    backoffMaxMs: 4000,
    backoffMaxRetries: 2,
    logPath,
    lineagePath: `/tmp/${runId}/postmortem`,
    runId,

    validate,
    evaluate,
    mutate,
    crossover,
    seed,
    select,
    shouldTerminate,
    onRetire,
  };

  const ea = new EA(config);
  const stop = startMonitor(ea);

  const start = Date.now();
  const result = await ea.run();
  stop();

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const tuple = result.bestIndividual.genome._tuple as string[];

  console.log(`\n=== Complete ===`);
  console.log(`  Generations:  ${result.generationsCompleted}`);
  console.log(`  Best fitness: ${result.bestFitness}`);
  console.log(`  Best config:  [${tuple.join(', ')}]`);
  console.log(`  Evals:        ${result.totalEvaluations}`);
  console.log(`  Cache hits:   ${(result.cacheHitRate * 100).toFixed(1)}%`);
  console.log(`  Elapsed:      ${elapsed}s\n`);
}

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

main().catch(console.error);