/**
 * Example 06 — Code Quality Evolution
 *
 * Evolves TypeScript/JavaScript code snippets using the heuristics module
 * as both validation gates and fitness evaluators.
 *
 * Genome: raw code string (_code field).
 *
 * Validation (heuristics.ts):
 *   - Cyclomatic complexity ≤ 15 per function
 *   - Type hint coverage ≥ 50%
 *   - Docstring coverage ≥ 30%
 *
 * Evaluation (heuristics.ts):
 *   - evaluateCodeQuality: 40% complexity fitness + 30% type hints + 30% docs
 *
 * Breeding:
 *   - Crossover: swap lines between two code individuals (line-level crossover)
 *   - Mutation: insert/remove/modify lines while maintaining syntactic validity
 *
 * Demonstrates:
 * - code artifact type
 * - heuristics.ts as the primary evaluation engine (no LLM needed)
 * - Line-level crossover and mutation on raw source
 * - EA with validate+evaluate both driven by heuristics
 *
 * Run: npx ts-node examples/06-code-quality-evolution.ts
 */

import { EA, EAConfig, Individual, RetireCause } from '../src/index.js';
import type { Genome } from '../src/index.js';
import {
  validateCyclomaticComplexity,
  validateTypeHintCoverage,
  validateDocstringCoverage,
  validateCodeQuality,
  evaluateCodeQuality,
  countCyclomaticComplexity,
  countTypeHintCoverage,
  countDocstringCoverage,
} from '../src/heuristics.js';

// =============================================================================
// Seed Population — hand-written snippets of varying quality
// =============================================================================

const SEED_CODES = [
  // Seed 0: Low quality — high complexity, no types, no docs
  `function process(a,b,c){
if(a>10){if(b>5){if(c>2){return a+b+c}else{return a+b}}else{return a}}else{return 0}}`,

  // Seed 1: Medium quality — moderate complexity, some types, no docs
  `function validateEmail(email: string): boolean {
  if (!email.includes('@')) return false;
  if (!email.includes('.')) return false;
  const parts = email.split('@');
  return parts.length === 2 && parts[0].length > 0 && parts[1].length > 2;
}`,

  // Seed 2: Better — typed, low complexity, no docstring
  `function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  return fn().catch(err => {
    if (attempts <= 1) throw err;
    return new Promise(resolve => setTimeout(resolve, 100))
      .then(() => retry(fn, attempts - 1));
  });
}`,

  // Seed 3: Good — typed, low complexity, has docstring
  `/**
 * Clamps a number to a [min, max] range.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}`,

  // Seed 4: High complexity, typed, no docs
  `function parseQuery(q: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  const pairs = q.split('&');
  for (const pair of pairs) {
    const [key, val] = pair.split('=');
    if (!key) continue;
    if (!result[key]) result[key] = [];
    result[key].push(decodeURIComponent(val ?? ''));
  }
  return result;
}`,

  // Seed 5: Medium quality
  `function memoize<T extends (...args: unknown[]) => unknown>(fn: T): T {
  const cache = new Map<string, unknown>();
  return ((...args: unknown[]) => {
    const key = JSON.stringify(args);
    if (cache.has(key)) return cache.get(key);
    const result = fn(...args);
    cache.set(key, result);
    return result;
  }) as T;
}`,

  // Seed 6: Low quality — nested conditionals
  `function grade(score: number): string {
  if (score >= 90) { if (score >= 95) { return 'A+' } else { return 'A' } }
  else if (score >= 80) { if (score >= 85) { return 'B+' } else { return 'B' } }
  else if (score >= 70) { if (score >= 75) { return 'C+' } else { return 'C' } }
  else if (score >= 60) { return 'D' }
  else { return 'F' }
}`,

  // Seed 7: Good — typed, well-structured, docstring
  `/**
 * Groups an array by a key function.
 */
function groupBy<T, K extends string>(
  items: T[],
  keyFn: (item: T) => K
): Record<K, T[]> {
  const result = {} as Record<K, T[]>;
  for (const item of items) {
    const key = keyFn(item);
    if (!result[key]) result[key] = [];
    result[key].push(item);
  }
  return result;
}`,
];

// =============================================================================
// EA Callbacks
// =============================================================================

/** Validation: all three heuristics gates */
async function validate(ind: Individual): Promise<{ valid: boolean; reason: string }> {
  return validateCodeQuality(ind);
}

/** Evaluation: heuristics composite fitness */
async function evaluate(ind: Individual): Promise<{
  fitness: number; metrics: Record<string, unknown>; judgeOutput: string;
}> {
  await sleep(5 + Math.random() * 10); // near-instant since pure computation
  return evaluateCodeQuality(ind);
}

/** Mutation: line-level mutations on code */
async function mutate(parent: Individual): Promise<Individual> {
  const code = (parent.genome._code as string) ?? '';
  const lines = code.split('\n');
  const newLines = [...lines];

  const op = Math.random();

  if (op < 0.3 && lines.length > 2) {
    // Remove a line
    const idx = 1 + Math.floor(Math.random() * (lines.length - 2));
    newLines.splice(idx, 1);
  } else if (op < 0.6) {
    // Modify a line
    const idx = 1 + Math.floor(Math.random() * (lines.length - 2));
    newLines[idx] = mutateLine(lines[idx]);
  } else if (op < 0.8) {
    // Add a type-annotated variable
    const idx = 1 + Math.floor(Math.random() * (lines.length - 1));
    const injections = [
      '  const _x: number = 0;',
      '  const _s: string = "";',
      '  const _b: boolean = false;',
      '  /** doc */ const _v: unknown = null;',
    ];
    newLines.splice(idx, 0, injections[Math.floor(Math.random() * injections.length)]);
  } else {
    // Add a docstring comment above a function
    const fnLineIdx = lines.findIndex(l => /^(?:export\s+)?(?:async\s+)?function\b/.test(l.trim()));
    if (fnLineIdx >= 0) {
      const fnName = lines[fnLineIdx].match(/function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/)?.[1] ?? 'fn';
      newLines.splice(fnLineIdx, 0, `/**\n * ${fnName} — evolved.\n */`);
    }
  }

  return { ...parent, genome: { ...parent.genome, _code: newLines.join('\n') } };
}

/** Mutate a single line of code */
function mutateLine(line: string): string {
  if (!line.trim()) return line;

  // Add or improve type annotation
  if (/:\s*\w+\s*[;,)]?$/.test(line) && !line.includes(': string') && !line.includes(': number')) {
    return line.replace(/: (\w+)/, ': string');
  }

  // Add return type to function-like lines
  if (/^  \w+\s*\(/.test(line) && !line.includes('): ')) {
    return line + ': unknown';
  }

  // Inline comment → docstring
  if (line.trim().startsWith('//') && !line.includes('/**')) {
    const comment = line.replace(/^\s*\/\/\s*/, '');
    return `  /** ${comment} */`;
  }

  // Default: add a trailing comment
  return line + ` // evolved`;
}

/** Line-level crossover: swap N consecutive lines between two individuals */
async function crossover(a: Individual, b: Individual): Promise<Individual> {
  const codeA = (a.genome._code as string) ?? '';
  const codeB = (b.genome._code as string) ?? '';
  const linesA = codeA.split('\n');
  const linesB = codeB.split('\n');

  if (linesA.length < 3 || linesB.length < 3) {
    return { ...a, genome: { ...a.genome }, parents: [a.id, b.id] };
  }

  // Pick a window in A and swap with a window in B
  const windowA = 1 + Math.floor(Math.random() * Math.min(4, linesA.length - 1));
  const startA = 1 + Math.floor(Math.random() * (linesA.length - windowA - 1));
  const startB = 1 + Math.floor(Math.random() * (linesB.length - windowA - 1));

  const childLines = [
    ...linesA.slice(0, startA),
    ...linesB.slice(startB, startB + windowA),
    ...linesA.slice(startA + windowA),
  ];

  return {
    ...a,
    genome: { ...a.genome, _code: childLines.join('\n') },
    parents: [a.id, b.id],
  };
}

/** Seed: from SEED_CODES pool */
async function seed(index: number): Promise<Genome> {
  return { _code: SEED_CODES[index % SEED_CODES.length] };
}

/** Rank-based selection: top half */
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
    const code = (ind.genome._code as string) ?? '';
    const preview = code.split('\n').slice(0, 3).join(' | ').slice(0, 80);
    const m = ind.metrics as Record<string, unknown>;
    console.log(
      `  ★ ${ind.id} fitness=${ind.fitness} cc=${m.maxComplexity} ` +
      `th=${m.typeHintPct}% docs=${m.docstringPct}% → ${preview}...`
    );
  }
}

// =============================================================================
// Heuristics smoke test — verify the module works standalone
// =============================================================================

function smokeTest(): void {
  const testCode = `/**
 * Adds two numbers.
 */
function add(a: number, b: number): number {
  return a + b;
}`;

  const cc = countCyclomaticComplexity(testCode);
  const th = countTypeHintCoverage(testCode);
  const dc = countDocstringCoverage(testCode);

  console.log(`  [smoke] cyclomatic=${cc} type_hint=${(th * 100).toFixed(0)}% docstring=${(dc * 100).toFixed(0)}%`);

  const ccResult = validateCyclomaticComplexity({ genome: { _code: testCode } } as Individual, 15);
  const thResult = validateTypeHintCoverage({ genome: { _code: testCode } } as Individual, 0.5);
  const dcResult = validateDocstringCoverage({ genome: { _code: testCode } } as Individual, 0.3);

  console.log(
    `  [smoke] CC valid=${ccResult.valid} TH valid=${thResult.valid} ` +
    `DC valid=${dcResult.valid}`
  );

  const fitness = evaluateCodeQuality({ genome: { _code: testCode } } as Individual);
  console.log(`  [smoke] fitness=${fitness.fitness} judge="${fitness.judgeOutput}"`);
}

// =============================================================================
// Monitor
// =============================================================================

function startMonitor(ea: EA): () => void {
  const id = setInterval(() => {
    if (ea.isDone()) { clearInterval(id); return; }
    const s = ea.getState();
    const best = ea.getBest();
    const m = best?.metrics as Record<string, unknown> | undefined;
    const bar = '█'.repeat(Math.round(s.bestFitness * 20)) +
                '░'.repeat(20 - Math.round(s.bestFitness * 20));
    console.log(
      `  gen=${String(s.generation).padStart(2)} ` +
      `eval=${s.evaluatedCount}/${s.populationSize} ` +
      `best=${s.bestFitness.toFixed(3)} ${bar} ` +
      `cc=${(m?.maxComplexity ?? '?')}` +
      ` th=${(m?.typeHintPct ?? '?')}%` +
      ` docs=${(m?.docstringPct ?? '?')}% ` +
      `stale=${s.stagnantRounds}`
    );
  }, 2000);
  return () => clearInterval(id);
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log('\n=== Example 06: Code Quality Evolution (Heuristics-driven) ===\n');
  console.log('Domain: Evolving TypeScript code using heuristics.ts as the evaluation engine.');
  console.log('Genome: Raw code string (_code field).');
  console.log('Validation: cyclomatic_complexity≤15, type_hints≥50%, docs≥30%');
  console.log('Fitness: 40%*complexity_fitness + 30%*type_hint_coverage + 30%*docstring_coverage');
  console.log('Breeding: Line-level crossover + insert/remove/modify mutations');
  console.log('Pop=8, survivors=4, early_stop=5\n');

  // Smoke test
  console.log('[smoke] Heuristics module:');
  smokeTest();
  console.log('');

  const runId = `codequal_${Date.now().toString(36)}`;

  const config: EAConfig = {
    artifactType: 'code',
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
  const bestCode = (result.bestIndividual.genome._code as string) ?? '';
  const m = result.bestIndividual.metrics as Record<string, unknown>;

  console.log(`\n=== Complete ===`);
  console.log(`  Run:          ${result.runId}`);
  console.log(`  Generations:  ${result.generationsCompleted}`);
  console.log(`  Best fitness: ${result.bestFitness}`);
  console.log(`  Heuristics:`);
  console.log(`    max_complexity: ${m.maxComplexity}`);
  console.log(`    type_hint_pct:  ${m.typeHintPct}%`);
  console.log(`    docstring_pct:  ${m.docstringPct}%`);
  console.log(`  Best code:\n${bestCode.split('\n').map(l => '    ' + l).join('\n')}`);
  console.log(`  Evals:        ${result.totalEvaluations}`);
  console.log(`  Cache hits:   ${(result.cacheHitRate * 100).toFixed(1)}%`);
  console.log(`  Elapsed:      ${elapsed}s\n`);

  if (bestEver) {
    const beCode = (bestEver.genome._code as string) ?? '';
    console.log(`  ★ Best ever:\n${beCode.split('\n').map(l => '    ' + l).join('\n')}`);
  }
}

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

main().catch(console.error);
