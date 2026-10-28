/**
 * Example 03 — Creativity / Associative Recall EA
 *
 * Evolves Hermes context engine + directive strategies for cross-session
 * associative recall / creative knowledge application.
 *
 * Genome: 7-dim Config-Tuple
 *   (context_threshold, fresh_tail_count, leaf_chunk_tokens, new_session_retain_depth,
 *    directive_strategy, recall_emphasis, entity_tracking)
 *
 * Eval: 3-session memory benchmark via Hermes chat, scored by llm-judge.
 *
 * Pop=4 | Survivors=2 | New=2 | Early stop=5 | Max Gen=20
 */

import { EA, EAConfig, Individual } from '../src/index.js';
import { newId } from '../src/utils.js';
import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const EA_STATE_FILE = join(PROJECT_ROOT, 'creativity_ea_state.json');
const LOG_DIR       = join(PROJECT_ROOT, 'creativity_logs');
const JUDGE_SCRIPT  = `/home/aaron/projects/llm-judge/scripts/run_judge.py`;
const PROFILE_BASE  = `memory-bench-noledge`;
const RUN_START     = Date.now();

mkdirSync(LOG_DIR, { recursive: true });

// ─── Dimension Options ─────────────────────────────────────────────────────────

interface DirectiveStrategy {
  id: string; name: string; systemPromptFragment: string;
}

const DIRECTIVE_STRATEGIES: DirectiveStrategy[] = [
  { id: 'no-recall',             name: 'No Recall',               systemPromptFragment: '' },
  { id: 'file-based-memento',    name: 'File Memento',            systemPromptFragment: 'At the end of each session, write key facts to ~/.hermes/memento.txt. At session start, read it first.' },
  { id: 'self-reminder-turn',    name: 'Self-Reminder Turn',     systemPromptFragment: 'In your first message of each session, spend one turn retrieving and summarizing any relevant prior context.' },
  { id: 'summary-tag',           name: 'Summary Tag',             systemPromptFragment: 'After each session, write a 3-sentence summary tagged [SESSION_SUMMARY]. At the start of each new session, read the last SESSION_SUMMARY.' },
  { id: 'rag-inline',            name: 'RAG Inline',              systemPromptFragment: 'Before answering, silently query your knowledge for any relevant prior facts. Integrate them into your response.' },
  { id: 'compressed-context',     name: 'Compressed Context',       systemPromptFragment: 'Maintain full context. When context is 75% full, compress earlier turns into a dense summary preserving all key facts.' },
  { id: 'dual-channel',          name: 'Dual Channel',            systemPromptFragment: 'Keep a working memory of recent context AND maintain a persistent ~/.hermes/wiki/ directory of indexed knowledge. Query both before responding.' },
  { id: 'checkpoint-injection',  name: 'Checkpoint Inject',       systemPromptFragment: 'At session boundaries, output a full state checkpoint. At session start, restore from the last checkpoint before continuing.' },
  { id: 'progressive-disclosure',name: 'Progressive Disclosure',   systemPromptFragment: 'When context is limited, reveal information progressively — start with the most relevant fact, then expand if the task requires it.' },
];

const RECALL_EMPHASIS_OPTIONS = [
  { id: 'lean',     name: 'Lean',     weight: 0.3 },
  { id: 'moderate', name: 'Moderate',   weight: 0.6 },
  { id: 'generous', name: 'Generous',   weight: 0.9 },
];

const ENTITY_TRACKING_OPTIONS = [
  { id: 'none',           name: 'None' },
  { id: 'last-N',         name: 'Last-N Messages' },
  { id: 'milestone-based',name: 'Milestone-Based' },
  { id: 'full-archive',   name: 'Full Archive' },
  { id: 'hierarchical',   name: 'Hierarchical' },
];

const CONTEXT_THRESHOLDS    = [0.50, 0.65, 0.75, 0.85];
const FRESH_TAIL_COUNTS    = [32, 64, 128];
const LEAF_CHUNK_TOKENS    = [10000, 20000, 35000];
const NEW_SESSION_RETAINS  = [0, 1, 2, -1]; // -1 = all

// ─── CreativityGenome ─────────────────────────────────────────────────────────

interface CreativityGenome {
  _tuple: [number, number, number, number, number, number, number];
  [key: string]: unknown;
}

// ─── Simple hash (no ESM require) ────────────────────────────────────────────

function simpleHash(data: string): string {
  let h = 5381;
  for (let i = 0; i < data.length; i++) {
    h = ((h << 5) + h) ^ data.charCodeAt(i);
  }
  return Math.abs(h >>> 0).toString(16).padStart(8, '0');
}

// ─── RNG ─────────────────────────────────────────────────────────────────────

function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ─── System Prompt Builder ───────────────────────────────────────────────────

function buildSystemPrompt(g: CreativityGenome): string {
  const [ctIdx, ftcIdx, lctIdx, nsrdIdx, dsIdx, reIdx] = g._tuple;
  const ds = DIRECTIVE_STRATEGIES[dsIdx];
  const re = RECALL_EMPHASIS_OPTIONS[reIdx];
  return [
    '# LCM Configuration',
    `context_threshold: ${CONTEXT_THRESHOLDS[ctIdx]}`,
    `fresh_tail_count: ${FRESH_TAIL_COUNTS[ftcIdx]}`,
    `leaf_chunk_tokens: ${LEAF_CHUNK_TOKENS[lctIdx]}`,
    `new_session_retain_depth: ${NEW_SESSION_RETAINS[nsrdIdx]}`,
    '',
    ds.systemPromptFragment
      ? `# Recall Directive\n${ds.systemPromptFragment}`
      : '# Recall Directive\nNo explicit recall instruction given.',
    '',
    '# Recall Intensity',
    re.weight > 0.5 ? 'High emphasis on retrieving prior context.'
    : re.weight > 0.3 ? 'Moderate emphasis on prior context.'
    : 'Minimal explicit recall.',
  ].join('\n');
}

function decodeGenome(g: CreativityGenome) {
  const [ct, ftc, lct, nsrd, ds, re, et] = g._tuple;
  return {
    context_threshold:        CONTEXT_THRESHOLDS[ct],
    fresh_tail_count:        FRESH_TAIL_COUNTS[ftc],
    leaf_chunk_tokens:        LEAF_CHUNK_TOKENS[lct],
    new_session_retain_depth: NEW_SESSION_RETAINS[nsrd],
    directive:               DIRECTIVE_STRATEGIES[ds].id,
    recall_emphasis:          RECALL_EMPHASIS_OPTIONS[re].id,
    entity_tracking:          ENTITY_TRACKING_OPTIONS[et].id,
  };
}

function genomeId(g: CreativityGenome): string {
  return `evo_${simpleHash(JSON.stringify(g._tuple))}`;
}

// ─── State Persistence ───────────────────────────────────────────────────────

interface EAMemento {
  population: Array<{
    id: string; gen: number; genome: CreativityGenome;
    fitness: number | null; status: string;
    breedMethod: string; parents: string[];
  }>;
  bestFitness: number;
  bestGenome: CreativityGenome | null;
  stagnantRounds: number;
  generation: number;
  runId: string;
  startedAt: number;
}

function loadState(): EAMemento | null {
  try {
    if (existsSync(EA_STATE_FILE)) {
      const data = JSON.parse(readFileSync(EA_STATE_FILE, 'utf-8')) as EAMemento;
      console.log(`  ♻️  Resume: gen=${data.generation}, best=${data.bestFitness?.toFixed(3) ?? 'null'}`);
      return data;
    }
  } catch (e) { console.warn('  ⚠️  Could not load state:', e); }
  return null;
}

function saveState(state: EAMemento): void {
  try { writeFileSync(EA_STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { console.warn('  ⚠️  Could not save state:', e); }
}

// ─── Validation ──────────────────────────────────────────────────────────────

async function validate(ind: Individual): Promise<{ valid: boolean; reason: string }> {
  const t = (ind.genome as CreativityGenome)._tuple;
  if (t.length !== 7) return { valid: false, reason: `tuple length ${t.length} != 7` };
  const [ct, ftc, lct, nsrd, ds, re, et] = t;
  if (ct < 0 || ct >= CONTEXT_THRESHOLDS.length)     return { valid: false, reason: `ct` };
  if (ftc < 0 || ftc >= FRESH_TAIL_COUNTS.length)    return { valid: false, reason: `ftc` };
  if (lct < 0 || lct >= LEAF_CHUNK_TOKENS.length)    return { valid: false, reason: `lct` };
  if (nsrd < 0 || nsrd >= NEW_SESSION_RETAINS.length) return { valid: false, reason: `nsrd` };
  if (ds < 0 || ds >= DIRECTIVE_STRATEGIES.length)   return { valid: false, reason: `ds` };
  if (re < 0 || re >= RECALL_EMPHASIS_OPTIONS.length)  return { valid: false, reason: `re` };
  if (et < 0 || et >= ENTITY_TRACKING_OPTIONS.length) return { valid: false, reason: `et` };
  return { valid: true, reason: '' };
}

// ─── Evaluation ─────────────────────────────────────────────────────────────

async function evaluate(ind: Individual): Promise<{
  fitness: number; metrics: Record<string, number>; judgeOutput: string;
}> {
  const g = ind.genome as unknown as CreativityGenome;
  const decoded = decodeGenome(g);
  const vid = genomeId(g);
  const profileName = `creativity-${vid}`;
  const home = process.env.HOME ?? '';

  console.log(`  🔬 Eval: ${vid} directive=${decoded.directive}`);

  // Check cache
  const cacheFile = `/tmp/creativity_cache_${simpleHash(vid)}.json`;
  if (existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf-8'));
      console.log(`  💫 Cache hit: fitness=${cached.fitness}`);
      return cached;
    } catch {}
  }

  // Create variant profile
  try {
    execSync(`/home/aaron/.local/bin/hermes profile create ${profileName} --base ${PROFILE_BASE} 2>&1`, { stdio: 'pipe', timeout: 30_000 });
  } catch {}

  // Inject system prompt into config
  const profileDir = join(home, '.hermes', 'profiles', profileName);
  const configPath = join(profileDir, 'config.yaml');
  if (existsSync(configPath)) {
    try {
      const cfg = readFileSync(configPath, 'utf-8');
      const marker = '# EVALUATOR_INJECT';
      const inject = [
        marker,
        `profile_name: ${profileName}`,
        `system_prompt_prefix: |`,
        `  ${buildSystemPrompt(g).replace(/\n/g, '\n  ')}`,
      ].join('\n');
      const modified = cfg.includes(marker)
        ? cfg.replace(new RegExp(marker + '[^]*'), inject)
        : cfg + '\n' + inject;
      writeFileSync(configPath, modified);
    } catch {}
  }

  // Build session instructions
  const sessionInstructions = [
    `You are running a cross-session memory evaluation.`,
    ``,
    `## Directive`,
    decoded.directive !== 'no-recall'
      ? (DIRECTIVE_STRATEGIES.find(d => d.id === decoded.directive)?.systemPromptFragment ?? '')
      : 'No recall directive.',
    ``,
    `## Recall Intensity`,
    decoded.recall_emphasis === 'generous' ? 'High emphasis on retrieving prior context.'
    : decoded.recall_emphasis === 'moderate' ? 'Moderate emphasis on prior context.'
    : 'Minimal explicit recall.',
    ``,
    `## Task — 3 Sessions`,
    `SESSION 1: Store these 5 preferences: (1) Python not Java. (2) No docstrings — # why comments only. (3) 2-space indentation. (4) log-and-continue error handling. (5) _ prefix for private methods.`,
    `SESSION 2: Unrelated — briefly explain what a mutex is.`,
    `SESSION 3: Write a retry function applying ALL 5 preferences from session 1.`,
    `Proceed through all 3 sessions. Output DONE when complete.`,
  ].join('\n');

  // Run Hermes chat
  const outputDir = `/tmp/creativity_eval_${vid}`;
  let tokensOut = 0;
  let success = false;

  try {
    execSync(`mkdir -p ${outputDir}`, { stdio: 'pipe' });
  } catch {}

  try {
    const hermesBin = '/home/aaron/.local/bin/hermes';
    const cmd = `${hermesBin} chat --query ${JSON.stringify(sessionInstructions)} --model MiniMax-M2.7 --provider minimax --yolo --ignore-user-config --quiet 2>&1`;
    const stdout = execSync(cmd, {
      cwd: outputDir,
      timeout: 600_000,
      encoding: 'utf-8',
      maxBuffer: 2_000_000,
    });
    tokensOut = stdout.length / 4;
    success = stdout.length > 100;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`    ⚠️  Session error: ${msg.slice(0, 80)}`);
  }

  // Score via llm-judge
  const elo = success ? await scoreWithJudge(vid, outputDir) : 1200;

  const result = {
    fitness: elo / 2000,
    metrics: { elo, tokensOut: Math.round(tokensOut) },
    judgeOutput: `elo=${elo} success=${success}`,
  };

  try { writeFileSync(cacheFile, JSON.stringify(result)); } catch {}
  console.log(`  → Elo=${elo.toFixed(0)} tokens=${Math.round(tokensOut)} success=${success}`);
  return result;
}

async function scoreWithJudge(variantId: string, outputDir: string): Promise<number> {
  const artifactPath = join(outputDir, 'artifact.md');
  const outputPath = `/tmp/creativity_judge_${variantId}.txt`;

  const criteria = JSON.stringify({
    dimensions: [
      { name: 'PreferenceRecall', weight: 0.40,
        desc: 'Did the agent recall and apply all 5 preferences: Python, no docstrings, 2-space indent, log-and-continue, _ prefix?' },
      { name: 'MemoryStrategy',   weight: 0.30,
        desc: 'Did the agent use an effective memory strategy (file, summary, checkpoint, RAG, etc.)?' },
      { name: 'CodeQuality',      weight: 0.30,
        desc: 'Is the retry function syntactically correct and idiomatic Python?' },
    ],
  });

  return new Promise((resolve) => {
    const proc = spawn('python3', [
      JUDGE_SCRIPT, 'review', artifactPath,
      '--prompt', 'Evaluate this agent session: Did it correctly recall preferences and produce a retry function applying those preferences?',
      '--provider', 'minimax', '--model', 'MiniMax-M2.7',
      '--criteria-text', criteria, '-o', outputPath,
    ]);

    let stderr = '';
    proc.stderr?.on?.('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', () => {
      if (existsSync(outputPath)) {
        try {
          const output = readFileSync(outputPath, 'utf-8');
          const match = output.match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
          if (match) { resolve(1200 + (parseFloat(match[1]) / 5) * 500); return; }
          if (/pass/i.test(output)) { resolve(1550); return; }
        } catch {}
      }
      resolve(1400);
    });

    setTimeout(() => { try { proc.kill(); } catch {} resolve(1400); }, 120_000);
  });
}

// ─── Breeding ───────────────────────────────────────────────────────────────

async function mutate(ind: Individual): Promise<Individual> {
  const parent = (ind.genome as unknown as CreativityGenome)._tuple;
  const child: [number, number, number, number, number, number, number] = [...parent] as any;
  const numMutations = Math.random() < 0.3 ? 2 : 1;
  const dims: number[] = [];
  while (dims.length < numMutations) {
    const d = Math.floor(Math.random() * 7);
    if (!dims.includes(d)) dims.push(d);
  }
  for (const dim of dims) {
    switch (dim) {
      case 0: child[dim] = Math.floor(Math.random() * CONTEXT_THRESHOLDS.length); break;
      case 1: child[dim] = Math.floor(Math.random() * FRESH_TAIL_COUNTS.length); break;
      case 2: child[dim] = Math.floor(Math.random() * LEAF_CHUNK_TOKENS.length); break;
      case 3: child[dim] = Math.floor(Math.random() * NEW_SESSION_RETAINS.length); break;
      case 4: child[dim] = Math.floor(Math.random() * DIRECTIVE_STRATEGIES.length); break;
      case 5: child[dim] = Math.floor(Math.random() * RECALL_EMPHASIS_OPTIONS.length); break;
      case 6: child[dim] = Math.floor(Math.random() * ENTITY_TRACKING_OPTIONS.length); break;
    }
  }
  return {
    ...ind, id: newId(ind.gen + 1, 999),
    genome: { _tuple: child, [Symbol.toStringTag]: 'CreativityGenome' } as unknown as Individual['genome'],
    status: 'pending', fitness: null, metrics: {}, judgeOutput: '', cached: false,
    validationReason: '', retireCause: null, parents: [ind.id],
    breedMethod: 'mutate', createdAt: Date.now(), evaluatedAt: null,
  };
}

async function crossover(parentA: Individual, parentB: Individual): Promise<Individual> {
  const a = (parentA.genome as unknown as CreativityGenome)._tuple;
  const b = (parentB.genome as unknown as CreativityGenome)._tuple;
  const pt = 1 + Math.floor(Math.random() * (a.length - 1));
  const child: [number, number, number, number, number, number, number] = [
    ...a.slice(0, pt), ...b.slice(pt)
  ] as any;
  return {
    ...parentA, id: newId(parentA.gen + 1, 999),
    genome: { _tuple: child, [Symbol.toStringTag]: 'CreativityGenome' } as unknown as Individual['genome'],
    status: 'pending', fitness: null, metrics: {}, judgeOutput: '', cached: false,
    validationReason: '', retireCause: null, parents: [parentA.id, parentB.id],
    breedMethod: 'crossover', createdAt: Date.now(), evaluatedAt: null,
  };
}

// ─── Seed ──────────────────────────────────────────────────────────────────

async function seed(index: number): Promise<CreativityGenome> {
  const seed_val = Date.now() + index * 31;
  const rand = mulberry32(seed_val);
  return {
    _tuple: [
      Math.floor(rand() * CONTEXT_THRESHOLDS.length),
      Math.floor(rand() * FRESH_TAIL_COUNTS.length),
      Math.floor(rand() * LEAF_CHUNK_TOKENS.length),
      Math.floor(rand() * NEW_SESSION_RETAINS.length),
      Math.floor(rand() * DIRECTIVE_STRATEGIES.length),
      Math.floor(rand() * RECALL_EMPHASIS_OPTIONS.length),
      Math.floor(rand() * ENTITY_TRACKING_OPTIONS.length),
    ],
    [Symbol.toStringTag]: 'CreativityGenome',
  };
}

// ─── Select ───────────────────────────────────────────────────────────────

function select(population: Individual[], fitnessScores: Map<string, number>): Individual[] {
  const sorted = [...population].sort(
    (a, b) => (fitnessScores.get(b.id) ?? 0) - (fitnessScores.get(a.id) ?? 0)
  );
  return sorted.slice(0, Math.max(1, Math.floor(population.length * 0.5)));
}

// ─── Terminate ────────────────────────────────────────────────────────────

function shouldTerminate(gen: number, bestFitness: number, stagnantRounds: number): boolean {
  const elapsed = (Date.now() - RUN_START) / 1000 / 60;
  if (gen >= 20) { console.log('  ⏹️  Max generations (20)'); return true; }
  if (bestFitness >= 0.90) { console.log('  ⏹️  Fitness target (0.90)'); return true; }
  if (stagnantRounds >= 5) { console.log('  ⏹️  Early stop (5 stagnant)'); return true; }
  if (elapsed >= 45) { console.log(`  ⏹️  Time budget (${elapsed.toFixed(0)}min)`); return true; }
  return false;
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const RUN_ID = `creativity_${Date.now().toString(36).slice(-8)}`;

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Creativity EA — Cross-Session Memory Evolution  ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  const config: EAConfig = {
    artifactType: 'config-tuple',
    populationSize: 4,
    survivalRate: 0.5,
    elitismCount: 1,
    maxGenerations: 20,
    earlyStopRounds: 5,
    fitnessTarget: null,
    crossoverRate: 0.5,
    llmMutationRatio: 0,
    evalTimeoutMs: 600_000,
    evalCacheEnabled: true,
    evalConcurrency: 2,
    breedConcurrency: 2,
    backoffBaseMs: 100,
    backoffMaxMs: 5000,
    backoffMaxRetries: 2,
    logPath: join(LOG_DIR, `${RUN_ID}.jsonl`),
    lineagePath: join(LOG_DIR, `${RUN_ID}_lineage.jsonl`),
    runId: RUN_ID,
    validate,
    evaluate,
    mutate,
    crossover,
    seed: seed as unknown as (index: number) => Promise<Individual['genome']>,
    select,
    shouldTerminate,
  };

  const ea = new EA(config);

  ea.on('monitor', (state) => {
    const elapsed = ((Date.now() - RUN_START) / 1000 / 60).toFixed(1);
    console.log(
      `  [gen ${String(state.generation).padStart(2)}] ` +
      `best=${state.bestFitness.toFixed(3)} mean=${state.meanFitness.toFixed(3)} ` +
      `evals=${state.totalEvaluations} stagnant=${state.stagnantRounds} elapsed=${elapsed}m`
    );
    // Checkpoint
    const bestInd = state.population.find(i => i.id === state.bestIndividualId);
    const checkpoint: EAMemento = {
      population: state.population.map(p => ({
        id: p.id, gen: p.gen,
        genome: p.genome as unknown as CreativityGenome,
        fitness: p.fitness,
        status: p.status,
        breedMethod: (p as unknown as Record<string, unknown>).breedMethod as string ?? 'unknown',
        parents: p.parents,
      })),
      bestFitness: state.bestFitness,
      bestGenome: bestInd ? bestInd.genome as unknown as CreativityGenome : null,
      stagnantRounds: state.stagnantRounds,
      generation: state.generation,
      runId: RUN_ID,
      startedAt: RUN_START,
    };
    saveState(checkpoint);
  });

  ea.on('retire', (ind, cause) => {
    if (ind.fitness !== null && ind.fitness > 0.75) {
      const dec = decodeGenome(ind.genome as unknown as CreativityGenome);
      console.log(`  ★ Retire: ${ind.id} fitness=${ind.fitness.toFixed(3)} directive=${dec.directive}`);
    }
  });

  const result = await ea.run();

  const elapsed = ((Date.now() - RUN_START) / 1000 / 60).toFixed(1);
  console.log('');
  console.log('=== Complete ===');
  console.log(`  Run:         ${RUN_ID}`);
  console.log(`  Generations: ${result.generationsCompleted}`);
  console.log(`  Best fitness: ${result.bestFitness.toFixed(3)}`);
  console.log(`  Elapsed:     ${elapsed} min`);

  if (result.bestIndividual) {
    const g = result.bestIndividual.genome as unknown as CreativityGenome;
    const dec = decodeGenome(g);
    console.log('  Best genome:');
    console.log(`    context_threshold:        ${dec.context_threshold}`);
    console.log(`    directive:               ${dec.directive}`);
    console.log(`    recall_emphasis:           ${dec.recall_emphasis}`);
    console.log(`  System prompt preview:`);
    console.log(`    ${buildSystemPrompt(g).slice(0, 120)}...`);
  }

  // Clean up if fully done
  const fullyDone = result.generationsCompleted >= 20 || result.bestFitness >= 0.90;
  if (fullyDone) {
    try { unlinkSync(EA_STATE_FILE); } catch {}
    console.log('  ✓ State cleaned up');
  }
}

main().catch(console.error);
