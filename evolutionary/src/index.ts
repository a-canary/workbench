/**
 * EA Framework — Public API
 *
 * Import everything from here:
 *   import { EA, EAConfig, Individual, Genome, ... } from 'evolve';
 */

export { EA } from './ea.js';
export type {
  EAConfig,
  Individual,
  Genome,
  EARunState,
  EARunResult,
  FitnessResult,
  ValidationResult,
  ArtifactType,
  EvalMethod,
  IndividualStatus,
  RetireCause,
  BreedMethod,
  LogEvent,
  LogEventType,
  RubricDim,
  Judgment,
  TrialResult,
  GeneValue,
  Gene,
  GeneBool,
  GeneCategorical,
  GeneFloat,
  GeneAny,
  GeneRegistry,
} from './types.js';
export { applyGeneRegistry } from './types.js';

export { SHA256EvalCache, NoOpCache } from './cache.js';
export type { EvalCache } from './cache.js';
export { LineageLogger } from './logger.js';
export { withBackoff, sleep } from './backoff.js';
export { Semaphore } from './semaphore.js';
export { newId, createIndividual, rouletteSelect, pickTwo, normalizeScore, safeConfig, ts } from './utils.js';

// Heuristics — programmatic validate/evaluate callbacks for code quality EA
export {
  validateCyclomaticComplexity,
  validateTypeHintCoverage,
  validateDocstringCoverage,
  validateCodeQuality,
  evaluateCyclomaticComplexity,
  evaluateTypeHintCoverage,
  evaluateDocstringCoverage,
  evaluateCodeQuality,
  countCyclomaticComplexity,
  countTypeHintCoverage,
  countDocstringCoverage,
} from './heuristics.js';

// Schematic-first adapter
export {
  BreedingStrategy,
  SchematicGenome,
  SchematicSection,
  SchematicField,
  CompileResult,
  ParentPoolEntry,
  SchematicEAConfig,
  parseSchematic,
  serializeSchematic,
  applyBreedingStrategy,
  crossoverSchematics,
  ParentPool,
  defaultChooseMutationStrategy,
  buildSchematicMutator,
  buildSchematicCrossover,
  buildSchematicSeed,
} from './schematic.js';