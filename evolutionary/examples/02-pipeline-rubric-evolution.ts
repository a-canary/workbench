/**
 * Example 02 — Pipeline Rubric Evolution
 *
 * Port of ~/projects/m27-research-opt domain to the evolutionary TypeScript library.
 *
 * Domain: Research pipeline evolution for 1200-word technical reports.
 *   Optimizing pipeline stage configurations using a 6-dimension rubric judge.
 *
 * Genome: Pipeline manifest — ordered list of stage configs.
 *   Each stage: { id: string, temp?: number, stages_before?: string[], critic_type?: string }
 *
 * Fitness: 6-dimension rubric score (each 1-5, total /30):
 *   technical_accuracy | technical_depth | task_relevance
 *   evidence_grounding | source_rigor | actionability
 *
 * Breeding:
 *   - Crossover: stage-subsequence swap between two pipeline manifests
 *   - Mutation: per-stage parameter perturbation (temperature, critic_type)
 *
 * Population: 8 | Survivors: 4 | Early stop: 5 stagnant rounds
 *
 * Run: npx ts-node examples/02-pipeline-rubric-evolution.ts
 */

import { EA, EAConfig, Individual, RetireCause } from '../src/index.js';

// =============================================================================
// Domain Constants — from m27-research-opt/CHOICES.md, paper/main.md
// =============================================================================

/** The 6 rubric dimensions used by m27's Sonnet judge */
const RUBRIC_DIMS = [
  'technical_accuracy',
  'technical_depth',
  'task_relevance',
  'evidence_grounding',
  'source_rigor',
  'actionability',
] as const;

type RubricDim = typeof RUBRIC_DIMS[number];

/** Stage types available in the pipeline */
const STAGE_TYPES = ['draft', 'critic-evidence', 'critic-depth', 'rubric-self', 'resolve', 'cite-fmt'] as const;
type StageType = typeof STAGE_TYPES[number];

/** Temperature options per stage */
const TEMPS = [0.0, 0.3, 0.5, 0.7] as const;
type Temp = typeof TEMPS[number];

// =============================================================================
// Genome — Pipeline Manifest
// =============================================================================

interface PipelineStage {
  id: string;
  type: StageType;
  temp: Temp;
}

interface PipelineGenome {
  _pipeline: PipelineStage[];
  _text?: string; // human-readable summary for logging
}

/** Human-readable pipeline summary for judgeOutput */
function pipelineSummary(genome: PipelineGenome): string {
  return genome._pipeline
    .map(s => `${s.id}(${s.type}, t=${s.temp})`)
    .join(' → ');
}

/** Random valid pipeline genome */
function randomPipeline(seed: number): PipelineGenome {
  const rand = mulberry32(seed);
  const stageCount = 3 + Math.floor(rand() * 3); // 3-5 stages
  const types = [...STAGE_TYPES];
  const stages: PipelineStage[] = [];

  const usedIds = new Set<string>();

  for (let i = 0; i < stageCount; i++) {
    let id: string;
    do {
      id = String.fromCharCode(97 + i); // a, b, c, ...
    } while (usedIds.has(id));
    usedIds.add(id);

    stages.push({
      id,
      type: types[Math.floor(rand() * types.length)],
      temp: TEMPS[Math.floor(rand() * TEMPS.length)],
    });
  }

  return { _pipeline: stages, _text: pipelineSummary(stages) };
}

// =============================================================================
// Callbacks
// =============================================================================

/**
 * Validation: structural constraints on pipeline manifests.
 * Mirrors m27's arm validation (each arm must have required stages).
 */
async function validate(ind: Individual): Promise<{ valid: boolean; reason: string }> {
  const pipeline = ind.genome._pipeline ?? [];

  // Must have at least 3 stages
  if (pipeline.length < 3) {
    return { valid: false, reason: `pipeline stages ${pipeline.length} < 3` };
  }

  // Stage IDs must be unique
  const ids = pipeline.map(s => s.id);
  if (new Set(ids).size !== ids.length) {
    return { valid: false, reason: 'duplicate stage IDs' };
  }

  // Must have at least one draft stage
  if (!pipeline.some(s => s.type === 'draft')) {
    return { valid: false, reason: 'no draft stage' };
  }

  // Must end with a resolve or cite-fmt stage
  const last = pipeline[pipeline.length - 1];
  if (!['resolve', 'cite-fmt'].includes(last.type)) {
    return { valid: false, reason: `last stage "${last.type}" not in [resolve, cite-fmt]` };
  }

  return { valid: true, reason: '' };
}

/**
 * Evaluation: 6-dimension rubric score.
 *
 * In the real m27 system this calls ke:rubric-reviewer (Sonnet judge).
 * Here we simulate the rubric with heuristics that mirror the real structure:
 *   - Draft stages at low temp → higher technical_depth
 *   - Evidence critic stages → higher evidence_grounding
 *   - Resolve stages → higher actionability
 *   - Source_rigor benefits from cite-fmt final stage
 *
 * Total /30. Baseline 18/30, range 10-28 in real runs.
 */
async function evaluate(ind: Individual): Promise<{ fitness: number; metrics: Record<string, number>; judgeOutput: string }> {
  await sleep(15 + Math.random() * 30); // simulate judge API latency

  const pipeline = ind.genome._pipeline ?? [];
  const scores: Record<string, number> = {};

  let technical_accuracy = 3;
  let technical_depth = 3;
  let task_relevance = 3;
  let evidence_grounding = 3;
  let source_rigor = 3;
  let actionability = 3;

  // Check stage composition
  const hasDraft = pipeline.some(s => s.type === 'draft');
  const hasEvidenceCritic = pipeline.some(s => s.type === 'critic-evidence');
  const hasDepthCritic = pipeline.some(s => s.type === 'critic-depth');
  const hasRubricSelf = pipeline.some(s => s.type === 'rubric-self');
  const hasResolve = pipeline.some(s => s.type === 'resolve');
  const hasCiteFmt = pipeline.some(s => s.type === 'cite-fmt');

  // technical_depth: low-temp draft + depth critic combo
  const draftStages = pipeline.filter(s => s.type === 'draft');
  const coldDraft = draftStages.some(s => s.temp <= 0.3);
  technical_depth += (coldDraft ? 1 : 0) + (hasDepthCritic ? 1 : 0);

  // evidence_grounding: evidence critic + resolve
  evidence_grounding += (hasEvidenceCritic ? 1 : 0) + (hasResolve ? 0.5 : 0);

  // technical_accuracy: benefits from rubric self-score stage
  technical_accuracy += hasRubricSelf ? 1 : 0;

  // task_relevance: structured pipeline (draft → critic → resolve)
  if (hasDraft && hasEvidenceCritic && hasResolve) task_relevance += 1;

  // source_rigor: cite-fmt final stage
  source_rigor += hasCiteFmt ? 1 : 0;

  // actionability: resolve stage is load-bearing (m27 finding: R11 without resolve = 23/30)
  actionability += hasResolve ? 1 : -0.5;

  // Clamp each dimension to 1-5
  for (const dim of RUBRIC_DIMS) {
    const val = eval(dim);
    scores[dim] = Math.max(1, Math.min(5, val));
  }

  const total = RUBRIC_DIMS.reduce((sum, dim) => sum + scores[dim], 0);
  const fitness = Math.round(total / 30 * 1000) / 1000; // normalize to 0-1

  const judgeOutput = RUBRIC_DIMS.map(d => `${d}=${scores[d]}`).join(' ') + ` total=${total}/30`;

  return { fitness, metrics: { ...scores, total }, judgeOutput };
}

/**
 * Mutation: per-stage parameter perturbation.
 * 50% chance per stage to mutate one parameter.
 */
async function mutate(parent: Individual): Promise<Individual> {
  const pipeline = [...(parent.genome._pipeline ?? [])].map(stage => ({ ...stage }));
  const rand = Math.random();

  if (rand < 0.5) {
    // Mutate one random stage's type
    const idx = Math.floor(Math.random() * pipeline.length);
    const currentType = pipeline[idx].type;
    const otherTypes = STAGE_TYPES.filter(t => t !== currentType);
    pipeline[idx] = { ...pipeline[idx], type: otherTypes[Math.floor(Math.random() * otherTypes.length)] };
  } else if (rand < 0.8) {
    // Mutate temperature of a random stage
    const idx = Math.floor(Math.random() * pipeline.length);
    const currentTemp = pipeline[idx].temp;
    const otherTemps = TEMPS.filter(t => t !== currentTemp);
    pipeline[idx] = { ...pipeline[idx], temp: otherTemps[Math.floor(Math.random() * otherTemps.length)] };
  } else {
    // Add or remove a stage (keep within 3-6 range)
    if (pipeline.length < 6 && Math.random() < 0.5) {
      const newId = String.fromCharCode(97 + pipeline.length);
      pipeline.push({ id: newId, type: 'critic-evidence', temp: 0.5 });
    } else if (pipeline.length > 3) {
      pipeline.splice(Math.floor(Math.random() * pipeline.length), 1);
    }
  }

  const newGenome: PipelineGenome = { _pipeline: pipeline, _text: pipelineSummary(pipeline) };
  return { ...parent, genome: newGenome };
}

/**
 * Crossover: stage-subsequence swap.
 * Picks a random subsequence boundary in each parent and swaps.
 */
async function crossover(a: Individual, b: Individual): Promise<Individual> {
  const pipeA = a.genome._pipeline ?? [];
  const pipeB = b.genome._pipeline ?? [];

  if (pipeA.length < 2 || pipeB.length < 2) {
    return { ...a, genome: { ...a.genome } };
  }

  // Single-point crossover on the stage sequence
  const pointA = 1 + Math.floor(Math.random() * (pipeA.length - 1));
  const pointB = 1 + Math.floor(Math.random() * (pipeB.length - 1));

  const newStages = [
    ...pipeA.slice(0, pointA),
    ...pipeB.slice(pointB),
  ];

  // Re-letter IDs to avoid collisions
  const reLetter = (stages: PipelineStage[]) =>
    stages.map((s, i) => ({ ...s, id: String.fromCharCode(97 + i) }));

  const crossed = reLetter(newStages);
  const newGenome: PipelineGenome = { _pipeline: crossed, _text: pipelineSummary(crossed) };

  return {
    ...a,
    genome: newGenome,
    parents: [a.id, b.id],
  };
}

/**
 * Seed: 8 random valid pipelines.
 */
async function seed(index: number): Promise<PipelineGenome> {
  return randomPipeline(index * 12345 + 42);
}

/**
 * Select: top 4 by rubric total.
 */
function select(population: Individual[], scores: Map<string, number>): Individual[] {
  return [...population]
    .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0))
    .slice(0, 4);
}

/**
 * Terminate: 5 stagnant rounds (matching m27's stopping condition).
 */
function shouldTerminate(_gen: number, _best: number, stagnant: number): boolean {
  return stagnant >= 5;
}

// =============================================================================
// Agent Lifecycle
// =============================================================================

let bestEver: Individual | null = null;

async function onRetire(ind: Individual, _cause: RetireCause): Promise<void> {
  const total = ind.metrics?.total ?? 0;
  if (!bestEver || (ind.fitness ?? 0) > (bestEver.fitness ?? 0)) {
    bestEver = { ...ind };
    console.log(`  ★ New best: ${ind.id} ${ind.genome._text} → ${total}/30`);
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
    const total = best?.metrics?.total ?? 0;
    const bar = '█'.repeat(Math.round(s.bestFitness * 20)) +
                '░'.repeat(20 - Math.round(s.bestFitness * 20));
    console.log(
      `  gen=${String(s.generation).padStart(2)} ` +
      `eval=${s.evaluatedCount}/${s.populationSize} ` +
      `best=${(s.bestFitness * 30).toFixed(1)}/30 ${bar} ` +
      `stale=${s.stagnantRounds} ` +
      `cache=${s.cacheSize} ` +
      `hits=${(s.cacheHitRate * 100).toFixed(0)}%`
    );
  }, 2000);
  return () => clearInterval(id);
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log('\n=== Example 02: Pipeline Rubric Evolution (m27-style) ===\n');
  console.log('Domain: ~/projects/m27-research-opt');
  console.log('Rubric: technical_accuracy, technical_depth, task_relevance,');
  console.log('        evidence_grounding, source_rigor, actionability (each 1-5, /30)');
  console.log('Genome: Pipeline manifest (ordered stage configs)');
  console.log('Breeding: Crossover (stage-subseq swap) + Mutation (per-stage params)');
  console.log('Pop=8, survivors=4, early_stop=5\n');

  const runId = `pipeline_${Date.now().toString(36)}`;

  const config: EAConfig = {
    artifactType: 'structured-text',
    populationSize: 8,
    survivalRate: 0.5,
    elitismCount: 1,
    maxGenerations: 20,
    earlyStopRounds: 5,
    fitnessTarget: null,
    crossoverRate: 0.4,
    llmMutationRatio: 0,   // mutation is parameter-space, not LLM
    evalTimeoutMs: 60_000,
    evalCacheEnabled: true,
    evalConcurrency: 4,
    breedConcurrency: 4,
    backoffBaseMs: 500,
    backoffMaxMs: 4000,
    backoffMaxRetries: 3,
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
  const total = result.bestIndividual.metrics?.total ?? 0;

  console.log(`\n=== Complete ===`);
  console.log(`  Run:          ${result.runId}`);
  console.log(`  Generations:  ${result.generationsCompleted}`);
  console.log(`  Total evals:  ${result.totalEvaluations}`);
  console.log(`  Cache hit %:  ${(result.cacheHitRate * 100).toFixed(1)}%`);
  console.log(`  Best fitness: ${result.bestFitness} (${total}/30)`);
  console.log(`  Best pipeline: ${result.bestIndividual.genome._text}`);
  console.log(`  Elapsed:      ${elapsed}s`);
  if (bestEver) {
    console.log(`\n  ★ Best ever: ${bestEver.id} — ${bestEver.genome._text} → ${bestEver.metrics?.total}/30`);
  }
  console.log();
}

// =============================================================================
// Utilities
// =============================================================================

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

/** Mulberry32 seeded PRNG — for reproducible pipeline seeds */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

main().catch(console.error);
