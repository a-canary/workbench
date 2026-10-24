/**
 * Example 05 — Research Arm Evolution
 *
 * Evolves research pipeline stage configurations using multi-signal evaluation.
 * Each pipeline arm = an ordered sequence of processing stages.
 *
 * Validation gates (heuristics.ts):
 *   - Cyclomatic complexity per stage ≤ 15
 *   - Type hint coverage ≥ 50%
 *   - Docstring coverage ≥ 30%
 *
 * Evaluation: simulated rubric score (6 dimensions, /30).
 * Mirrors the m27-research-opt domain structure.
 *
 * Demonstrates:
 * - structured-text artifact type (pipeline manifest)
 * - heuristics.ts as pre-evolution validation gates
 * - Stage-subsequence crossover + per-stage mutation
 * - Multi-dimensional rubric fitness
 *
 * Run: npx ts-node examples/05-research-arm-evolution.ts
 */

import { EA, EAConfig, Individual, RetireCause } from '../src/index.js';
import {
  validateCyclomaticComplexity,
  validateTypeHintCoverage,
  validateDocstringCoverage,
} from '../src/heuristics.js';

// =============================================================================
// Domain Constants
// =============================================================================

const RUBRIC_DIMS = [
  'technical_accuracy',
  'technical_depth',
  'task_relevance',
  'evidence_grounding',
  'source_rigor',
  'actionability',
] as const;

type RubricDim = typeof RUBRIC_DIMS[number];

/** Available processing stage types */
const STAGE_TYPES = [
  'query-expand', 'semantic-search', 'bm25-retrieve', 'rerank',
  'extract-claims', 'cite-verify', 'synthesis', 'outline-build',
  'draft-revise', 'fact-check', 'contradict-detect', 'conclusion-draw',
] as const;
type StageType = typeof STAGE_TYPES[number];

const TEMPS = [0.0, 0.3, 0.5, 0.7] as const;
type Temp = typeof TEMPS[number];

// =============================================================================
// Pipeline Genome
// =============================================================================

interface PipelineStage {
  id: string;
  type: StageType;
  temp: Temp;
  /** Inline code snippet for this stage (evolved) */
  snippet?: string;
}

interface PipelineGenome {
  _yaml?: Record<string, unknown>;
  /** Ordered list of stage configs */
  _pipeline: PipelineStage[];
  /** Human-readable summary */
  _text?: string;
}

function pipelineSummary(genome: PipelineGenome): string {
  return genome._pipeline.map(s => `${s.id}(${s.type}, t=${s.temp})`).join(' → ');
}

function randomPipeline(seed: number, minStages = 3, maxStages = 6): PipelineStage[] {
  const rand = seededRand(seed);
  const count = minStages + Math.floor(rand() * (maxStages - minStages + 1));
  const stages: PipelineStage[] = [];

  for (let i = 0; i < count; i++) {
    stages.push({
      id: String.fromCharCode(97 + i),
      type: STAGE_TYPES[Math.floor(rand() * STAGE_TYPES.length)],
      temp: TEMPS[Math.floor(rand() * TEMPS.length)],
      snippet: makeSnippet(STAGE_TYPES[Math.floor(rand() * STAGE_TYPES.length)], i, rand),
    });
  }
  return stages;
}

/** Generate a plausible TypeScript snippet for a stage type */
function makeSnippet(type: StageType, idx: number, rand: () => number): string {
  const snips: Record<StageType, string> = {
    'query-expand': `function expandQuery(q: string): string[] {\n  const terms = q.toLowerCase().split(/\\s+/);\n  return terms.flatMap(t => [t, synonym(t)].filter(Boolean));\n}`,
    'semantic-search': `async function semanticSearch(query: string, k = 10): Promise<string[]> {\n  const embedding = await embed(query);\n  return await index.query(embedding, { k });\n}`,
    'bm25-retrieve': `function bm25Retrieve(query: string, corpus: string[], k = 10): string[] {\n  const scores = corpus.map(doc => bm25Score(query, doc));\n  return topK(scores, k).map(i => corpus[i]);\n}`,
    'rerank': `async function rerank(query: string, docs: string[]): Promise<string[]> {\n  const scores = await Promise.all(docs.map(d => crossEncoder(query, d)));\n  return docs.slice().sort((a, b) => scores[docs.indexOf(b)] - scores[docs.indexOf(a)]);\n}`,
    'extract-claims': `function extractClaims(text: string): Claim[] {\n  return text.split(/\\.\\s+/).map(s => ({ text: s, verdict: 'unknown' }));\n}`,
    'cite-verify': `async function citeVerify(claim: string): Promise<boolean> {\n  const sources = await search(claim);\n  return sources.length > 0;\n}`,
    'synthesis': `async function synthesize(chunks: string[]): Promise<string> {\n  const prompt = SUMMARIZE_PROMPT.replace('{{chunks}}', chunks.join('\\n'));\n  return await llm(prompt);\n}`,
    'outline-build': `function buildOutline(sections: string[]): Outline {\n  return { sections: sections.map((t, i) => ({ title: t, order: i })) };\n}`,
    'draft-revise': `async function draftRevise(text: string, feedback: string): Promise<string> {\n  const prompt = REVISE_PROMPT.replace('{{text}}', text).replace('{{feedback}}', feedback);\n  return await llm(prompt);\n}`,
    'fact-check': `async function factCheck(claim: string, sources: string[]): Promise<Verdict> {\n  const verdicts = await Promise.all(sources.map(s => llm(CHECK_PROMPT(claim, s))));\n  return aggregate(verdicts);\n}`,
    'contradict-detect': `function detectContradictions(claims: Claim[]): Contradiction[] {\n  return claims.flatMap((c, i) =>\n    claims.slice(i + 1).filter(o => opposes(c.text, o.text)).map(o => ({ a: c, b: o }))\n  );\n}`,
    'conclusion-draw': `async function drawConclusion(evidence: string[]): Promise<string> {\n  const prompt = CONCLUSION_PROMPT.replace('{{evidence}}', evidence.join('\\n'));\n  return await llm(prompt);\n}`,
  };
  return snips[type] ?? `function stage${idx}(input: string): string { return input; }`;
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
// Heuristics validation wrappers
// =============================================================================

/** Gate: all pipeline snippets must satisfy complexity + coverage thresholds */
async function validatePipelineSnippets(
  ind: Individual
): Promise<{ valid: boolean; reason: string }> {
  const genome = ind.genome as unknown as PipelineGenome;
  const stages = genome._pipeline ?? [];

  for (const stage of stages) {
    if (!stage.snippet) continue;

    // Temporarily set _code for heuristics validation
    const snippetInd = { ...ind, genome: { _code: stage.snippet } as Individual['genome'] };

    // Complexity gate
    const cc = validateCyclomaticComplexity(snippetInd, 15);
    if (!cc.valid) return { valid: false, reason: `${stage.id}: ${cc.reason}` };

    // Type hint coverage gate
    const th = validateTypeHintCoverage(snippetInd, 0.5);
    if (!th.valid) return { valid: false, reason: `${stage.id}: ${th.reason}` };

    // Docstring coverage gate
    const dc = validateDocstringCoverage(snippetInd, 0.3);
    if (!dc.valid) return { valid: false, reason: `${stage.id}: ${dc.reason}` };
  }

  return { valid: true, reason: '' };
}

// =============================================================================
// EA Callbacks
// =============================================================================

/** Validation: structural + heuristics gates on snippets */
async function validate(ind: Individual): Promise<{ valid: boolean; reason: string }> {
  const pipeline = (ind.genome as unknown as PipelineGenome)._pipeline ?? [];

  if (pipeline.length < 3) {
    return { valid: false, reason: `stages ${pipeline.length} < 3` };
  }

  // Stage IDs unique
  const ids = pipeline.map(s => s.id);
  if (new Set(ids).size !== ids.length) {
    return { valid: false, reason: 'duplicate stage IDs' };
  }

  // Must start with retrieval or query-expand
  const firstType = pipeline[0]?.type;
  if (!['query-expand', 'semantic-search', 'bm25-retrieve'].includes(firstType)) {
    return { valid: false, reason: `first stage "${firstType}" must be retrieval` };
  }

  // Must end with conclusion or synthesis
  const lastType = pipeline[pipeline.length - 1]?.type;
  if (!['synthesis', 'conclusion-draw', 'draft-revise'].includes(lastType)) {
    return { valid: false, reason: `last stage "${lastType}" must be synthesis/conclusion` };
  }

  // Heuristics gates on snippets
  return validatePipelineSnippets(ind);
}

/**
 * Evaluation: 6-dimension rubric score.
 * Simulates m27-style rubric with stage-composition heuristics.
 */
async function evaluate(ind: Individual): Promise<{
  fitness: number; metrics: Record<string, unknown>; judgeOutput: string;
}> {
  await sleep(15 + Math.random() * 30);

  const pipeline = (ind.genome as unknown as PipelineGenome)._pipeline ?? [];
  const scores: Record<string, number> = {} as Record<string, number>;

  let technical_accuracy = 3;
  let technical_depth = 3;
  let task_relevance = 3;
  let evidence_grounding = 3;
  let source_rigor = 3;
  let actionability = 3;

  const hasType = (t: StageType) => pipeline.some(s => s.type === t);

  // technical_depth: low-temp synthesis + fact-check combo
  const coldSynth = pipeline.some(s => s.type === 'synthesis' && s.temp <= 0.3);
  technical_depth += (coldSynth ? 1 : 0) + (hasType('fact-check') ? 1 : 0);

  // evidence_grounding: cite-verify + extract-claims
  evidence_grounding += (hasType('cite-verify') ? 1 : 0) + (hasType('extract-claims') ? 0.5 : 0);

  // technical_accuracy: contradiction-detect + fact-check
  technical_accuracy += (hasType('contradict-detect') ? 1 : 0) + (hasType('fact-check') ? 0.5 : 0);

  // task_relevance: retrieval → rerank → synthesis is the canonical path
  const hasRetrieval = hasType('semantic-search') || hasType('bm25-retrieve');
  const hasRerank = hasType('rerank');
  const hasSynth = hasType('synthesis');
  if (hasRetrieval && hasRerank && hasSynth) task_relevance += 1.5;

  // source_rigor: cite-verify + query-expand (broad recall)
  source_rigor += (hasType('cite-verify') ? 1 : 0) + (hasType('query-expand') ? 0.5 : 0);

  // actionability: conclusion-draw + outline-build
  actionability += (hasType('conclusion-draw') ? 1 : 0) + (hasType('outline-build') ? 0.5 : 0);

  // Clamp
  for (const dim of RUBRIC_DIMS) {
    const val = eval(dim);
    scores[dim] = Math.max(1, Math.min(5, val));
  }

  const total = RUBRIC_DIMS.reduce((sum, dim) => sum + scores[dim], 0);
  const fitness = Math.round(total / 30 * 1000) / 1000;

  return {
    fitness,
    metrics: { ...scores, total },
    judgeOutput: RUBRIC_DIMS.map(d => `${d}=${scores[d]}`).join(' ') + ` total=${total}/30`,
  };
}

/** Mutation: per-stage type swap, temperature perturbation, or snippet mutation */
async function mutate(parent: Individual): Promise<Individual> {
  const genome = parent.genome as unknown as PipelineGenome;
  const pipeline = genome._pipeline.map(s => ({ ...s }));

  const rand = Math.random();

  if (rand < 0.4) {
    // Mutate one stage's type
    const idx = Math.floor(Math.random() * pipeline.length);
    const current = pipeline[idx].type;
    const others = STAGE_TYPES.filter(t => t !== current);
    pipeline[idx] = { ...pipeline[idx], type: others[Math.floor(Math.random() * others.length)] };
  } else if (rand < 0.7) {
    // Mutate temperature
    const idx = Math.floor(Math.random() * pipeline.length);
    const current = pipeline[idx].temp;
    const others = TEMPS.filter(t => t !== current);
    pipeline[idx] = { ...pipeline[idx], temp: others[Math.floor(Math.random() * others.length)] };
  } else {
    // Mutate snippet (trim or expand by 1-2 lines)
    const idx = Math.floor(Math.random() * pipeline.length);
    const snippet = pipeline[idx].snippet ?? '';
    pipeline[idx] = {
      ...pipeline[idx],
      snippet: mutateSnippet(snippet, seededRand(Date.now())),
    };
  }

  const newGenome: PipelineGenome = { _pipeline: pipeline, _text: pipelineSummary({ _pipeline: pipeline }) };
  return { ...parent, genome: newGenome as unknown as Individual['genome'] };
}

/** Simple snippet mutation: add/remove/alter a line */
function mutateSnippet(snippet: string, rand: () => number): string {
  const lines = snippet.split('\n');
  const op = rand();

  if (op < 0.33 && lines.length > 3) {
    // Remove a middle line
    const removeIdx = 1 + Math.floor(rand() * (lines.length - 2));
    lines.splice(removeIdx, 1);
  } else if (op < 0.66) {
    // Replace a line with an equivalent
    const modifyIdx = 1 + Math.floor(rand() * (lines.length - 2));
    const old = lines[modifyIdx];
    if (old.includes('return')) {
      lines[modifyIdx] = old.replace('return', '// return');
    } else if (old.startsWith('  ')) {
      lines[modifyIdx] = old.replace(/^  /, '    ');
    }
  } else {
    // Add a comment line
    const insertIdx = 1 + Math.floor(rand() * (lines.length - 1));
    lines.splice(insertIdx, 0, `  // heuristic: evolved stage`);
  }

  return lines.join('\n');
}

/** Crossover: stage-subsequence swap between two pipelines */
async function crossover(a: Individual, b: Individual): Promise<Individual> {
  const pipeA = (a.genome as unknown as PipelineGenome)._pipeline ?? [];
  const pipeB = (b.genome as unknown as PipelineGenome)._pipeline ?? [];

  if (pipeA.length < 2 || pipeB.length < 2) {
    return { ...a, genome: { ...a.genome }, parents: [a.id, b.id] };
  }

  const ptA = 1 + Math.floor(Math.random() * (pipeA.length - 1));
  const ptB = 1 + Math.floor(Math.random() * (pipeB.length - 1));

  // Re-letter IDs to avoid collisions
  const reLetter = (stages: PipelineStage[], offset = 0): PipelineStage[] =>
    stages.map((s, i) => ({ ...s, id: String.fromCharCode(97 + i + offset) }));

  const newStages = reLetter([...pipeA.slice(0, ptA), ...pipeB.slice(ptB)]);

  const newGenome: PipelineGenome = {
    _pipeline: newStages,
    _text: pipelineSummary({ _pipeline: newStages }),
  };

  return { ...a, genome: newGenome as unknown as Individual['genome'], parents: [a.id, b.id] };
}

/** Seed: random valid pipeline */
async function seed(index: number): Promise<PipelineGenome> {
  const stages = randomPipeline(index * 1337 + 7);
  const genome: PipelineGenome = { _pipeline: stages, _text: pipelineSummary({ _pipeline: stages }) };
  return genome as unknown as { _text: string } & PipelineGenome;
}

/** Select: top 4 by rubric total */
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
  const total = ind.metrics?.total ?? 0;
  if (!bestEver || (ind.fitness ?? 0) > (bestEver.fitness ?? 0)) {
    bestEver = { ...ind };
    const g = ind.genome as unknown as PipelineGenome;
    console.log(`  ★ ${ind.id} fitness=${ind.fitness} → ${g._text} → ${total}/30`);
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
      `stale=${s.stagnantRounds} cache=${s.cacheSize}`
    );
  }, 2000);
  return () => clearInterval(id);
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log('\n=== Example 05: Research Arm Evolution ===\n');
  console.log('Domain: Research pipeline evolution (m27-style rubric)');
  console.log('Stages: query-expand, semantic-search, bm25-retrieve, rerank,');
  console.log('       extract-claims, cite-verify, synthesis, outline-build,');
  console.log('       draft-revise, fact-check, contradict-detect, conclusion-draw');
  console.log('Validation gates (heuristics.ts): complexity≤15, type_hints≥50%, docs≥30%');
  console.log('Rubric: technical_accuracy, technical_depth, task_relevance,');
  console.log('        evidence_grounding, source_rigor, actionability (each 1-5, /30)');
  console.log('Pop=8, survivors=4, early_stop=5\n');

  const runId = `research_${Date.now().toString(36)}`;

  const config: EAConfig = {
    artifactType: 'structured-text',
    populationSize: 8,
    survivalRate: 0.5,
    elitismCount: 1,
    maxGenerations: 20,
    earlyStopRounds: 5,
    fitnessTarget: null,
    crossoverRate: 0.4,
    llmMutationRatio: 0,
    evalTimeoutMs: 60_000,
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
    seed: seed as unknown as (index: number) => Promise<{ _text?: string }>,
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
  const g = result.bestIndividual.genome as unknown as PipelineGenome;
  const total = result.bestIndividual.metrics?.total ?? 0;

  console.log(`\n=== Complete ===`);
  console.log(`  Run:          ${result.runId}`);
  console.log(`  Generations:  ${result.generationsCompleted}`);
  console.log(`  Best fitness: ${result.bestFitness} (${total}/30)`);
  console.log(`  Best pipeline: ${g._text}`);
  console.log(`  Evals:        ${result.totalEvaluations}`);
  console.log(`  Cache hits:   ${(result.cacheHitRate * 100).toFixed(1)}%`);
  console.log(`  Elapsed:      ${elapsed}s\n`);

  if (bestEver) {
    const be = bestEver as unknown as { genome: PipelineGenome };
    const beTotal = bestEver.metrics?.total ?? 0;
    console.log(`  ★ Best ever: ${bestEver.id} — ${be.genome._text} → ${beTotal}/30`);
  }
}

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

main().catch(console.error);
