/**
 * Core Types — EA Framework
 *
 * All types are in one place so they're easy to import and reference.
 * No external dependencies.
 */

// =============================================================================
// Artifact Types
// =============================================================================

export type ArtifactType =
  | 'free-text'
  | 'structured-text'
  | 'code'
  | 'config-tuple'
  | 'pipeline'
  | 'concept';

// =============================================================================
// Evaluation
// =============================================================================

export type EvalMethod =
  | 'pass-rate'       // programmatic: exit code, regex, test suite
  | 'metric'          // programmatic: numeric (tokens, latency, accuracy)
  | 'llm-judge-rubric' // separate LLM with structured rubric
  | 'llm-judge-pairwise' // separate LLM comparing two variants (ELO)
  | 'human-oracle';   // human picks preferred variant

export interface FitnessResult {
  fitness: number;
  metrics: Record<string, unknown>;
  judgeOutput: string;
}

export interface ValidationResult {
  valid: boolean;
  reason: string;
}

// =============================================================================
// Genome — the artifact being evolved
// Tag union lets callers discriminate by artifact type
// =============================================================================

export interface Genome {
  // Discriminant tags (at most one set per individual)
  _text?: string;              // free-text, structured-text
  _yaml?: Record<string, unknown>; // structured-text, schematic
  _code?: string;               // code (raw text)
  _tuple?: unknown[];           // config-tuple (fixed-length array)

  // Free-form payload for custom types
  [key: string]: unknown;
}

// =============================================================================
// Individual — one variant in the population
// =============================================================================

export type IndividualStatus =
  | 'pending'    // created, not yet validated
  | 'validating' // validation in progress
  | 'valid'      // passed validation, ready to evaluate
  | 'invalid'    // failed validation
  | 'evaluating' // evaluation in progress
  | 'evaluated'  // fitness assigned
  | 'retired';   // removed from living population

export type RetireCause =
  | 'low-fitness'
  | 'validation-fail'
  | 'timeout'
  | 'error'
  | 'manual';

export type BreedMethod = 'seed' | 'mutate' | 'crossover';

// =============================================================================
// RubricDim — multi-dimensional fitness scores (m27-research-opt, hermes-evo)
// Used when a single scalar fitness isn't enough; each dimension is a sub-score.
// The overall fitness is computed from these, not stored directly.
// =============================================================================

/** One dimension of a multi-dimensional fitness score */
export interface RubricDim {
  [dimension: string]: number; // e.g., { technical_accuracy: 0.85, task_relevance: 0.9 }
}

/** A single evaluation judgment — the raw output from one judge */
export interface Judgment {
  rubric: RubricDim;
  overall: number;           // composite score [0, 1]
  reasoning: string;         // judge's explanation
  model: string;             // e.g., 'opus-4-5-20250514'
  timestamp: number;         // unix ms
}

/** Result of one trial (one individual evaluated on one task) */
export interface TrialResult {
  trialId: string;
  individualId: string;
  taskId: string;
  judgment: Judgment;
  latencyMs: number;
  costUsd?: number;         // optional cost tracking
  cached?: boolean;
}

// =============================================================================
// Gene types — for gene-based config evolution (optimize-no-ledge, memory EAs)
// A gene is a named, typed dimension of a config genome.
// =============================================================================

export type GeneValue = boolean | string | number;

export interface Gene {
  name: string;
  description: string;
}

export interface GeneBool extends Gene {
  kind: 'bool';
  default: boolean;
}

export interface GeneCategorical extends Gene {
  kind: 'categorical';
  options: string[];
  default: string;
}

export interface GeneFloat extends Gene {
  kind: 'float';
  min: number;
  max: number;
  default: number;
}

export type GeneAny = GeneBool | GeneCategorical | GeneFloat;

/** A registry of genes that define a config space */
export interface GeneRegistry {
  name: string;
  genes: GeneAny[];
}

/** Apply a gene registry to a tuple of values — returns a Genome */
export function applyGeneRegistry(registry: GeneRegistry, values: GeneValue[]): Genome {
  const g: Genome = { _tuple: values };
  for (let i = 0; i < registry.genes.length; i++) {
    g[registry.genes[i].name] = values[i];
  }
  return g;
}

export interface Individual {
  id: string;           // stable: g{gen}_p{index}
  gen: number;          // generation number
  status: IndividualStatus;
  genome: Genome;
  fitness: number | null;
  metrics: Record<string, unknown>;
  judgeOutput: string;
  cached: boolean;      // true if fitness came from cache
  validationReason: string;
  retireCause: RetireCause | null;
  parents: string[];    // parent individual IDs (empty for seed)
  breedMethod: BreedMethod;
  createdAt: number;   // unix ms
  evaluatedAt: number | null;
}

// =============================================================================
// Log Schema
// =============================================================================

export type LogEventType =
  | 'run_start'
  | 'seed'
  | 'validate'
  | 'evaluate'
  | 'generation_end'
  | 'select'
  | 'retire'
  | 'bred'
  | 'terminate'
  | 'run_end';

export interface LogEvent {
  type: LogEventType;
  run_id: string;
  gen?: number;
  id?: string;
  ts: string;
  [key: string]: unknown;
}

// =============================================================================
// EA Configuration
// =============================================================================

export interface EAConfig {
  // ── Artifact ──────────────────────────────────────────────────────────────
  artifactType: ArtifactType;

  // ── Population ────────────────────────────────────────────────────────────
  populationSize: number;
  survivalRate: number;
  elitismCount: number;

  // ── Termination ────────────────────────────────────────────────────────────
  maxGenerations: number;
  earlyStopRounds: number;
  fitnessTarget: number | null;

  // ── Breeding ──────────────────────────────────────────────────────────────
  crossoverRate: number;          // probability of crossover vs mutation
  llmMutationRatio: number;       // for text artifacts: 70% = LLM mutation

  // ── Evaluation ─────────────────────────────────────────────────────────────
  evalTimeoutMs: number;
  evalCacheEnabled: boolean;       // default true — SHA256 by genome content
  evalConcurrency: number;         // max parallel evaluations
  breedConcurrency: number;        // max parallel breeding operations

  // ── Backoff ───────────────────────────────────────────────────────────────
  backoffBaseMs: number;
  backoffMaxMs: number;
  backoffMaxRetries: number;

  // ── Output ─────────────────────────────────────────────────────────────────
  logPath: string;
  lineagePath: string;
  runId: string;

  // ── Callbacks (required) ───────────────────────────────────────────────────
  validate: (ind: Individual) => Promise<ValidationResult>;
  evaluate: (ind: Individual) => Promise<FitnessResult>;
  mutate: (ind: Individual) => Promise<Individual>;
  crossover: (parentA: Individual, parentB: Individual) => Promise<Individual>;
  seed: (index: number) => Promise<Genome>;
  select: (population: Individual[], fitnessScores: Map<string, number>) => Individual[];
  shouldTerminate: (gen: number, bestFitness: number, stagnantRounds: number) => boolean;

// ── Optional hooks ───────────────────────────────────────────────────────
  /** Agent decides what to do with a retired artifact (archive, discard, promote) */
  onRetire?: (ind: Individual, cause: RetireCause) => Promise<void>;
  /** Called after each generation completes */
  onGenerationEnd?: (gen: number, best: Individual | null, mean: number) => Promise<void>;
  /** Called after each generation end — agent drives monitoring from this */
  onMonitor?: (state: EARunState) => void;

  // ── Optional gates ──────────────────────────────────────────────────────
  /**
   * Optional benchmark gate — a fast smoke test that an individual must pass
   * before being accepted into the population or before expensive evaluation.
   * Return true to pass, false to fail and mark invalid.
   * Used to ensure evolved configs don't regress on established benchmarks.
   */
  benchmarkGate?: (ind: Individual) => Promise<boolean>;
}

// =============================================================================
// Run State & Result
// =============================================================================

export interface EARunState {
  runId: string;
  generation: number;
  populationSize: number;
  evaluatedCount: number;
  retiredCount: number;
  bestFitness: number;
  meanFitness: number;
  stagnantRounds: number;
  totalEvaluations: number;
  cacheHitRate: number;
  cacheSize: number;
}

export interface EARunResult {
  runId: string;
  generationsCompleted: number;
  bestIndividual: Individual;
  bestFitness: number;
  totalEvaluations: number;
  cacheHitRate: number;
  terminated: boolean;
  terminateReason: string;
}