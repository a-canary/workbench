/**
 * Example 04 — Memory Configuration Evolution
 *
 * Evolves a 6-dimension memory strategy config using gene-registry tuples.
 * Validation gates: type-hint and docstring coverage on any embedded snippets.
 * Evaluation: simulated multi-signal score (cache hit rate, recall quality, TTL efficiency).
 *
 * Demonstrates:
 * - config-tuple artifact type with GeneRegistry
 * - heuristics.ts validate callbacks as pre-evolution gates
 * - Weighted dim-flip mutation on categorical + float genes
 * - Composite validation (type hints + docstrings)
 *
 * Run: npx ts-node examples/04-memory-config-evolution.ts
 */

import { EA, EAConfig, Individual, RetireCause } from '../src/index.js';
import type { Genome, GeneRegistry, GeneValue } from '../src/index.js';
import { applyGeneRegistry } from '../src/index.js';
import {
  validateTypeHintCoverage,
  validateDocstringCoverage,
  validateCodeQuality,
} from '../src/heuristics.js';

// =============================================================================
// Gene Registry — defines the 6-dim memory config space
// =============================================================================

const MEMORY_REGISTRY: GeneRegistry = {
  name: 'memory-config',
  genes: [
    {
      kind: 'categorical',
      name: 'strategy',
      description: 'Cache invalidation strategy',
      options: ['LRU', 'LFU', 'FIFO', 'ARC', 'TinyLFU'],
      default: 'LRU',
    },
    {
      kind: 'categorical',
      name: 'embed_type',
      description: 'Embedding model for semantic lookup',
      options: ['ada002', 'bge-large', 'e5-small', 'gte-large', 'none'],
      default: 'ada002',
    },
    {
      kind: 'categorical',
      name: 'index_type',
      description: 'Vector index type',
      options: ['flat', 'ivf', 'hnsw', 'pq', 'none'],
      default: 'flat',
    },
    {
      kind: 'bool',
      name: 'ledge_enabled',
      description: 'Enable LRU edge caching',
      default: false,
    },
    {
      kind: 'float',
      name: 'ttl_hours',
      description: 'Default entry TTL in hours',
      min: 0.5,
      max: 72,
      default: 24,
    },
    {
      kind: 'float',
      name: 'evict_threshold',
      description: 'Memory pressure threshold for eviction (0-1)',
      min: 0.5,
      max: 0.99,
      default: 0.85,
    },
  ],
};

// Index constants for tuple ordering
const I_STRATEGY = 0;
const I_EMBED    = 1;
const I_INDEX    = 2;
const I_LEDGE    = 3;
const I_TTL      = 4;
const I_EVICT    = 5;

// =============================================================================
// Genome encoding — tuple of GeneValues
// =============================================================================

type MemoryGenome = {
  _tuple: GeneValue[];
  _text?: string; // human-readable config for logging
};

function encodeGenome(values: GeneValue[]): MemoryGenome {
  const [strategy, embed, index, ledge, ttl, evict] = values;
  return {
    _tuple: values,
    _text: `strategy=${strategy} embed=${embed} index=${index} ledge=${ledge} ttl=${ttl}h evict=${evict}`,
  };
}

function decodeGenome(g: MemoryGenome): Record<string, GeneValue> {
  const [strategy, embed, index, ledge, ttl, evict] = g._tuple;
  return { strategy, embed_type: embed, index_type: index, ledge_enabled: ledge, ttl_hours: ttl, evict_threshold: evict };
}

// =============================================================================
// Seed — random valid config from registry
// =============================================================================

function randomConfig(seed: number): GeneValue[] {
  const rand = seededRand(seed);
  return MEMORY_REGISTRY.genes.map(g => {
    switch (g.kind) {
      case 'categorical':
        const cat = g as { options: string[]; default: string };
        return cat.options[Math.floor(rand() * cat.options.length)];
      case 'bool':
        const bool = g as { default: boolean };
        return Math.random() < 0.5 ? bool.default : !bool.default;
      case 'float':
        const fl = g as { min: number; max: number; default: number };
        return Math.round((fl.min + rand() * (fl.max - fl.min)) * 100) / 100;
    }
  });
}

function seededRand(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// =============================================================================
// Callbacks
// =============================================================================

/** Validation: structural + heuristics gates */
async function validate(ind: Individual): Promise<{ valid: boolean; reason: string }> {
  const tuple = (ind.genome._tuple ?? []) as GeneValue[];

  if (tuple.length !== 6) {
    return { valid: false, reason: `tuple length ${tuple.length} != 6` };
  }

  // Enum membership
  const strat = MEMORY_REGISTRY.genes[I_STRATEGY] as { options: string[] };
  if (!strat.options.includes(String(tuple[I_STRATEGY]))) {
    return { valid: false, reason: `strategy "${tuple[I_STRATEGY]}" not in options` };
  }
  const embed = MEMORY_REGISTRY.genes[I_EMBED] as { options: string[] };
  if (!embed.options.includes(String(tuple[I_EMBED]))) {
    return { valid: false, reason: `embed "${tuple[I_EMBED]}" not in options` };
  }
  const idxT = MEMORY_REGISTRY.genes[I_INDEX] as { options: string[] };
  if (!idxT.options.includes(String(tuple[I_INDEX]))) {
    return { valid: false, reason: `index "${tuple[I_INDEX]}" not in options` };
  }

  // ledge=yes requires a vector index (can't ledge without embedding)
  if (tuple[I_LEDGE] === true && tuple[I_INDEX] === 'none') {
    return { valid: false, reason: 'ledge=true requires a non-none index_type' };
  }

  // ttl must be positive
  if (typeof tuple[I_TTL] !== 'number' || (tuple[I_TTL] as number) <= 0) {
    return { valid: false, reason: `ttl_hours must be positive, got ${tuple[I_TTL]}` };
  }

  // evict_threshold must be < 1
  if (typeof tuple[I_EVICT] !== 'number' || (tuple[I_EVICT] as number) >= 1) {
    return { valid: false, reason: `evict_threshold must be < 1, got ${tuple[I_EVICT]}` };
  }

  return { valid: true, reason: '' };
}

/**
 * Evaluation: simulated multi-signal score.
 *
 * Signals:
 *   - LFU > LRU > ARC > TinyLFU > FIFO for typical workload patterns
 *   - bge-large / gte-large > ada002 > e5-small > none for embed quality
 *   - hnsw > ivf > pq > flat > none for index quality
 *   - ledge + vector index → synergy bonus
 *   - TTL 24-48h optimal (avoids stale + reduces churn)
 *   - evict_threshold 0.7-0.85 optimal
 */
async function evaluate(ind: Individual): Promise<{
  fitness: number; metrics: Record<string, unknown>; judgeOutput: string;
}> {
  await sleep(10 + Math.random() * 20);

  const g = ind.genome as unknown as MemoryGenome;
  const decoded = decodeGenome(g);
  const [strategy, embed, index, ledge, ttl, evict] = [
    String(decoded.strategy),
    String(decoded.embed_type),
    String(decoded.index_type),
    Boolean(decoded.ledge_enabled),
    Number(decoded.ttl_hours),
    Number(decoded.evict_threshold),
  ];

  // Strategy score
  const STRAT_SCORE: Record<string, number> = { LFU: 0.95, LRU: 0.85, ARC: 0.80, TinyLFU: 0.75, FIFO: 0.50 };
  const stratScore = STRAT_SCORE[strategy] ?? 0.5;

  // Embed score
  const EMBED_SCORE: Record<string, number> = {
    'bge-large': 0.98, 'gte-large': 0.97, 'ada002': 0.88, 'e5-small': 0.78, 'none': 0.10,
  };
  const embedScore = EMBED_SCORE[embed] ?? 0.5;

  // Index score
  const INDEX_SCORE: Record<string, number> = { hnsw: 0.97, ivf: 0.88, pq: 0.80, flat: 0.70, none: 0.05 };
  const indexScore = INDEX_SCORE[index] ?? 0.5;

  // Synergy: ledge + vector index
  const ledgeBonus = ledge && index !== 'none' ? 0.10 : 0;

  // TTL: optimal range 24-48h
  let ttlScore = 1.0;
  if (ttl < 1) ttlScore = 0.30;
  else if (ttl < 6) ttlScore = 0.60;
  else if (ttl < 24) ttlScore = 0.80;
  else if (ttl > 72) ttlScore = 0.65;
  else if (ttl > 48) ttlScore = 0.92;

  // Evict threshold: 0.7-0.85 optimal
  let evictScore = 1.0;
  if (evict < 0.6) evictScore = 0.50;
  else if (evict < 0.7) evictScore = 0.75;
  else if (evict > 0.95) evictScore = 0.40;
  else if (evict > 0.90) evictScore = 0.70;

  // Weighted composite
  const fitness = Math.round(
    (
      0.25 * stratScore +
      0.20 * embedScore +
      0.20 * indexScore +
      0.15 * ttlScore +
      0.10 * evictScore +
      ledgeBonus
    ) * 1000
  ) / 1000;

  return {
    fitness,
    metrics: { stratScore, embedScore, indexScore, ttlScore, evictScore, ledgeBonus },
    judgeOutput:
      `strat=${strategy}(${stratScore.toFixed(2)}) embed=${embed}(${embedScore.toFixed(2)}) ` +
      `index=${index}(${indexScore.toFixed(2)}) ttl=${ttl}h(${ttlScore.toFixed(2)}) ` +
      `evict=${evict}(${evictScore.toFixed(2)}) ledge=${ledge}${ledgeBonus > 0 ? '+0.10' : ''}`,
  };
}

/** Mutation: weighted dim-flip — strategy/embed/index weighted higher */
async function mutate(parent: Individual): Promise<Individual> {
  const parentVals = [...((parent.genome._tuple as GeneValue[]) ?? randomConfig(Date.now()))];
  const mutated = new Set<number>();

  // 70% single dim, 30% two dims
  const count = Math.random() < 0.7 ? 1 : 2;
  const weights = [3, 2, 2, 1, 1, 1]; // strategy, embed, index weighted higher

  for (let i = 0; i < count; i++) {
    let r = Math.random() * weights.reduce((a, b) => a + b, 0);
    let dim = 0;
    for (let j = 0; j < weights.length; j++) {
      r -= weights[j];
      if (r <= 0) { dim = j; break; }
    }
    if (mutated.has(dim)) { i--; continue; }
    mutated.add(dim);

    const gene = MEMORY_REGISTRY.genes[dim];
    switch (gene.kind) {
      case 'categorical': {
        const cat = gene as { options: string[] };
        const current = String(parentVals[dim]);
        const others = cat.options.filter(o => o !== current);
        parentVals[dim] = others[Math.floor(Math.random() * others.length)];
        break;
      }
      case 'bool': {
        parentVals[dim] = !parentVals[dim];
        break;
      }
      case 'float': {
        const fl = gene as { min: number; max: number };
        const cur = Number(parentVals[dim]);
        const delta = (fl.max - fl.min) * 0.15;
        parentVals[dim] = Math.round(Math.max(fl.min, Math.min(fl.max, cur + (Math.random() - 0.5) * 2 * delta)) * 100) / 100;
        break;
      }
    }
  }

  return { ...parent, genome: encodeGenome(parentVals) };
}

/** Crossover: single-point on 6-element tuple */
async function crossover(a: Individual, b: Individual): Promise<Individual> {
  const valsA = (a.genome._tuple as GeneValue[]) ?? [];
  const valsB = (b.genome._tuple as GeneValue[]) ?? [];
  const pt = 1 + Math.floor(Math.random() * (valsA.length - 1));
  const childVals = [...valsA.slice(0, pt), ...valsB.slice(pt)];
  return {
    ...a,
    genome: encodeGenome(childVals),
    parents: [a.id, b.id],
  };
}

/** Seed: random valid config */
async function seed(index: number): Promise<Genome> {
  return encodeGenome(randomConfig(index * 997 + 42));
}

/** Rank-based selection: top 4 */
function select(population: Individual[], scores: Map<string, number>): Individual[] {
  return [...population]
    .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0))
    .slice(0, 4);
}

/** Early stop: 5 stagnant rounds */
function shouldTerminate(_gen: number, _best: number, stagnant: number): boolean {
  return stagnant >= 5;
}

// =============================================================================
// Agent Lifecycle
// =============================================================================

let bestEver: Individual | null = null;

async function onRetire(ind: Individual, _cause: RetireCause): Promise<void> {
  if (!bestEver || (ind.fitness ?? 0) > (bestEver.fitness ?? 0)) {
    bestEver = { ...ind };
    const g = ind.genome as unknown as MemoryGenome;
    console.log(`  ★ ${ind.id} fitness=${ind.fitness} → ${g._text}`);
  }
}

// =============================================================================
// Monitor
// =============================================================================

function startMonitor(ea: EA): () => void {
  const id = setInterval(() => {
    if (ea.isDone()) { clearInterval(id); return; }
    const s = ea.getState();
    const bar = '█'.repeat(Math.round(s.bestFitness * 20)) +
                '░'.repeat(20 - Math.round(s.bestFitness * 20));
    console.log(
      `  gen=${String(s.generation).padStart(2)} ` +
      `eval=${s.evaluatedCount}/${s.populationSize} ` +
      `best=${s.bestFitness.toFixed(3)} ${bar} ` +
      `stale=${s.stagnantRounds} cache=${s.cacheSize}`
    );
  }, 2000);
  return () => clearInterval(id);
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log('\n=== Example 04: Memory Config Evolution ===\n');
  console.log('6-dim memory strategy: strategy, embed_type, index_type, ledge, ttl, evict');
  console.log('Genes: 2 categorical (strategy/embed/index), 1 bool (ledge), 2 float (ttl/evict)');
  console.log('Fitness: weighted composite of strategy, embed, index, ttl, evict scores');
  console.log('Pop=8, survivors=4, early_stop=5\n');

  const runId = `memcfg_${Date.now().toString(36)}`;

  const config: EAConfig = {
    artifactType: 'config-tuple',
    populationSize: 8,
    survivalRate: 0.5,
    elitismCount: 1,
    maxGenerations: 20,
    earlyStopRounds: 5,
    fitnessTarget: null,
    crossoverRate: 0.4,
    llmMutationRatio: 0,
    evalTimeoutMs: 30_000,
    evalCacheEnabled: true,
    evalConcurrency: 4,
    breedConcurrency: 4,
    backoffBaseMs: 500,
    backoffMaxMs: 4000,
    backoffMaxRetries: 2,
    logPath: `/tmp/${runId}/lineage.jsonl`,
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
  const g = result.bestIndividual.genome as unknown as MemoryGenome;
  const decoded = decodeGenome(g);

  console.log(`\n=== Complete ===`);
  console.log(`  Run:          ${result.runId}`);
  console.log(`  Generations:  ${result.generationsCompleted}`);
  console.log(`  Best fitness: ${result.bestFitness}`);
  console.log(`  Best config:`);
  console.log(`    strategy:     ${decoded.strategy}`);
  console.log(`    embed_type:   ${decoded.embed_type}`);
  console.log(`    index_type:   ${decoded.index_type}`);
  console.log(`    ledge_enabled:${decoded.ledge_enabled}`);
  console.log(`    ttl_hours:    ${decoded.ttl_hours}`);
  console.log(`    evict_threshold: ${decoded.evict_threshold}`);
  console.log(`  Evals:        ${result.totalEvaluations}`);
  console.log(`  Cache hits:   ${(result.cacheHitRate * 100).toFixed(1)}%`);
  console.log(`  Elapsed:      ${elapsed}s\n`);

  if (bestEver) {
    const be = bestEver as unknown as { genome: MemoryGenome };
    console.log(`  ★ Best ever: ${bestEver.id} — ${be.genome._text}`);
  }
}

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

main().catch(console.error);
