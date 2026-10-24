/**
 * Schematic-First EA Adapter
 *
 * Enables the "schematic-first" workflow used by starlight-slm:
 *   1. Evolve a SchematicGenome (YAML) — cheap, human-readable
 *   2. Compile to code via `compile` callback — generates model.py
 *   3. Test/evaluate the compiled artifact — expensive, scored
 *   4. Select survivors → breed next generation of schematics
 *
 * The compile step is the critical adapter between the EA (which evolves
 * schematics) and the downstream system (which evaluates code). This
 * separation allows the EA to operate on a lightweight representation
 * while the full system evaluates the compiled output.
 *
 * Multi-generation parent pool: when breeding, the pool is drawn from
 * all evaluated individuals across the last N generations, not just the
 * current population. This preserveselite genetic material across gens.
 */

import type { Individual, Genome } from './types.js';

// =============================================================================
// Types
// =============================================================================

/** 9 breeding strategies for schematic-first evolution */
export enum BreedingStrategy {
  /** Small targeted mutation to a single field */
  SMALL_MUTATION = 'small_mutation',
  /** Large structural mutation — change multiple fields or architecture */
  LARGE_MUTATION = 'large_mutation',
  /** Combine successful features from two parents */
  FEATURE_CROSSOVER = 'feature_crossover',
  /** Abstraction: replace specific values with parameters/variables */
  ABSTRACT = 'abstract',
  /** Instantiate: replace a parameter with a concrete value */
  INSTANTIATE = 'instantiate',
  /** Combine two schematics at a random boundary */
  SINGLE_POINT_CROSSOVER = 'single_point_crossover',
  /** Randomly shuffle field order to test position sensitivity */
  SHUFFLE = 'shuffle',
  /** Inject a novel pattern not present in parent pool */
  INNOVATION = 'innovation',
  /** Simplify: remove unnecessary fields/structure */
  SIMPLIFY = 'simplify',
}

/**
 * A schematic genome — structured YAML-like key-value pairs that describe
 * an artifact (model architecture, config, pipeline, etc.).
 *
 * Unlike Genome._yaml which is free-form, SchematicGenome has a specific
 * structure: sections → fields → values. This allows structural mutations
 * that operate at the field level, not the raw text level.
 */
export interface SchematicGenome {
  _schematic: SchematicSection[];
  /** Optional: target parameter count hint for mutation/innovation */
  targetParams?: string;
  /** Optional: key changes from parent (for crossover documentation) */
  keyChanges?: string[];
}

export interface SchematicSection {
  name: string;
  fields: SchematicField[];
}

export interface SchematicField {
  key: string;
  value: unknown;
  mutationWeight: number; // relative probability of being mutated
}

export interface CompileResult {
  success: boolean;
  /** Compiled artifact (e.g. model.py, config.yaml) as a Genome */
  artifact: Genome;
  /** Human-readable summary of what was produced */
  summary: string;
  /** Any issues or warnings from compilation */
  warnings?: string[];
}

export interface ParentPoolEntry {
  individual: Individual;
  fitness: number;
  age: number; // generations since this individual was bred
}

/**
 * Configuration for the schematic-first EA adapter.
 * Consumers (starlight-slm) provide the compile callback and optional pool config.
 */
export interface SchematicEAConfig {
  /** How many generations of survivors to keep in the parent pool */
  parentPoolGenerations: number;
  /** Minimum fitness (0-1) for an individual to enter the parent pool */
  parentPoolMinFitness: number;
  /**
   * Compile a SchematicGenome → executable Artifact (Genome).
   * This is the bridge between the EA's lightweight schematic representation
   * and the full evaluation target.
   *
   * starlight-slm example: compile YAML schematic → model.py + config.yaml
   */
  compile: (schematic: SchematicGenome, parentHints?: string[]) => Promise<CompileResult>;

  /**
   * Optional mutation strategy sampler.
   * If not provided, strategies are chosen uniformly at random.
   * Return: [strategy, mutation intensity 0-1]
   */
  chooseMutationStrategy?: (
    parent: Individual,
    parentFitness: number,
    generation: number
  ) => { strategy: BreedingStrategy; intensity: number };

  /**
   * Optional: validate a compiled artifact before it enters evaluation.
   * Return true to pass, false to mark invalid.
   */
  validateCompiled?: (artifact: Genome, compiled: CompileResult) => Promise<boolean>;

  /** Optional: custom scoring for schematic complexity (used in wordcount-style penalty) */
  schematicComplexity?: (genome: SchematicGenome) => number;
}

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Parse a raw YAML-like string into a SchematicGenome.
 * Used when initializing from existing schematics (e.g. loading starlight-slm artifacts).
 *
 * The input is a simple structured format: each section is "## SectionName",
 * fields are "  key: value" with optional weight annotation "// weight:N".
 */
export function parseSchematic(yaml: string): SchematicGenome {
  const sections: SchematicSection[] = [];
  const lines = yaml.split('\n');

  let currentSection: SchematicSection | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('## ')) {
      if (currentSection) sections.push(currentSection);
      currentSection = { name: line.slice(3).trim(), fields: [] };
    } else if (currentSection && line.includes(':')) {
      const colonIdx = line.indexOf(':');
      const key = line.slice(0, colonIdx).trim();
      let value: unknown = line.slice(colonIdx + 1).trim();
      let mutationWeight = 1.0;

      // Parse weight annotation: "key: value  // weight:2.0"
      const weightMatch = (value as string).toString().match(/\/\/\s*weight:(\d+(?:\.\d+)?)/);
      if (weightMatch) {
        mutationWeight = parseFloat(weightMatch[1]);
        value = (value as string).toString().replace(weightMatch[0], '').trim();
      }

      // Try to parse as number or bool
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      else if (!isNaN(Number(value)) && value !== '') value = Number(value);

      currentSection.fields.push({ key, value, mutationWeight });
    }
  }

  if (currentSection) sections.push(currentSection);
  return { _schematic: sections };
}

/**
 * Serialize a SchematicGenome back to a readable YAML-like format.
 * Used for logging and debugging.
 */
export function serializeSchematic(schematic: SchematicGenome): string {
  const lines: string[] = [];
  for (const section of schematic._schematic) {
    lines.push(`## ${section.name}`);
    for (const field of section.fields) {
      const weightStr = field.mutationWeight !== 1.0 ? `  // weight:${field.mutationWeight}` : '';
      const valueStr = typeof field.value === 'string' ? field.value : JSON.stringify(field.value);
      lines.push(`  ${field.key}: ${valueStr}${weightStr}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Apply a breeding strategy to a schematic genome.
 * Returns a new SchematicGenome with the appropriate mutation applied.
 *
 * The actual mutation logic (how to change each field) is delegated to
 * field-level mutation helpers so strategies are composable.
 */
export async function applyBreedingStrategy(
  strategy: BreedingStrategy,
  parent: SchematicGenome,
  _config: SchematicEAConfig,
  intensity: number = 0.5,
  externalInnovation?: string // for INNOVATION strategy
): Promise<SchematicGenome> {

  switch (strategy) {
    case BreedingStrategy.SMALL_MUTATION: {
      return smallMutation(parent, intensity);
    }

    case BreedingStrategy.LARGE_MUTATION: {
      // Apply small mutation multiple times
      let result = parent;
      const iterations = Math.ceil(intensity * 4);
      for (let i = 0; i < iterations; i++) {
        result = smallMutation(result, 0.8);
      }
      return result;
    }

    case BreedingStrategy.FEATURE_CROSSOVER: {
      // Feature crossover requires two parents — caller must handle this
      return parent; // caller passes second parent separately
    }

    case BreedingStrategy.ABSTRACT: {
      return abstractSchematic(parent);
    }

    case BreedingStrategy.INSTANTIATE: {
      return instantiateSchematic(parent);
    }

    case BreedingStrategy.SINGLE_POINT_CROSSOVER: {
      // Caller passes second parent — this returns parent as-is, caller must combine
      return parent;
    }

    case BreedingStrategy.SHUFFLE: {
      return shuffleFields(parent, intensity);
    }

    case BreedingStrategy.INNOVATION: {
      return innovateSchematic(parent, externalInnovation);
    }

    case BreedingStrategy.SIMPLIFY: {
      return simplifySchematic(parent, intensity);
    }

    default:
      return parent;
  }
}

/** Small mutation: pick 1-2 fields weighted by mutationWeight, change their values */
function smallMutation(parent: SchematicGenome, intensity: number): SchematicGenome {
  const _schematicClone: SchematicSection[] = JSON.parse(JSON.stringify(parent._schematic));
  const schematic = _schematicClone.map(section => ({
    ...section,
    fields: section.fields.map(field => ({ ...field })),
  }));

  const allFields: { sectionIdx: number; fieldIdx: number; weight: number }[] = [];
  for (let si = 0; si < schematic.length; si++) {
    for (let fi = 0; fi < schematic[si].fields.length; fi++) {
      allFields.push({ sectionIdx: si, fieldIdx: fi, weight: schematic[si].fields[fi].mutationWeight });
    }
  }

  const totalWeight = allFields.reduce((s, f) => s + f.weight, 0);
  const mutateCount = intensity < 0.5 ? 1 : 2;

  for (let m = 0; m < mutateCount; m++) {
    let r = Math.random() * totalWeight;
    let selected: (typeof allFields)[0] | null = null;
    for (const f of allFields) {
      r -= f.weight;
      if (r <= 0) { selected = f; break; }
    }
    if (!selected) continue;

    const field = schematic[selected.sectionIdx].fields[selected.fieldIdx];
    field.value = mutateFieldValue(field.value);
  }

  return { ...parent, _schematic: schematic };
}

/** Mutate a single field value based on its type */
function mutateFieldValue(value: unknown): unknown {
  if (typeof value === 'number') {
    // Add ±20% noise, round to sensible precision
    const noise = 1 + (Math.random() - 0.5) * 0.4;
    return Math.round(value * noise * 100) / 100;
  } else if (typeof value === 'string') {
    // String mutation: rarely flip case, rarely truncate, mostly leave as-is
    const roll = Math.random();
    if (roll < 0.1) return value.toUpperCase();
    if (roll < 0.2) return value.toLowerCase();
    if (roll < 0.3 && value.length > 5) return value.slice(0, Math.floor(value.length * 0.7));
    return value;
  } else if (typeof value === 'boolean') {
    return !value;
  }
  return value;
}

/** Abstract: replace concrete values with parameter placeholders */
function abstractSchematic(parent: SchematicGenome): SchematicGenome {
  const schematic = parent._schematic.map(section => ({
    ...section,
    fields: section.fields.map(field => ({ ...field })),
  }));

  // Pick 1-2 fields to abstract (replace value with ${PARAM_NAME})
  const abstratableFields = schematic
    .flatMap((s, si) => s.fields.map((f, fi) => ({ sectionIdx: si, fieldIdx: fi, field: f })))
    .filter(({ field }) => typeof field.value === 'string' || typeof field.value === 'number');

  const count = Math.min(abstratableFields.length, 1 + Math.floor(Math.random() * 2));
  const selected = abstratableFields
    .sort(() => Math.random() - 0.5)
    .slice(0, count);

  for (const { sectionIdx, fieldIdx } of selected) {
    const field = schematic[sectionIdx].fields[fieldIdx];
    const paramName = `${schematic[sectionIdx].name}_${field.key}`.toUpperCase().replace(/\s+/g, '_');
    field.value = `\${${paramName}}`;
  }

  return { ...parent, _schematic: schematic };
}

/** Instantiate: replace parameter placeholders with concrete values */
function instantiateSchematic(parent: SchematicGenome): SchematicGenome {
  const schematic = parent._schematic.map(section => ({
    ...section,
    fields: section.fields.map(field => ({ ...field })),
  }));

  for (const section of schematic) {
    for (const field of section.fields) {
      if (typeof field.value === 'string' && field.value.startsWith('${') && field.value.endsWith('}')) {
        // Replace with a reasonable concrete value based on field name
        field.value = getConcreteValue(field.key, field.value);
      }
    }
  }

  return { ...parent, _schematic: schematic };
}

function getConcreteValue(key: string, placeholder: string): unknown {
  const key_lower = key.toLowerCase();
  if (key_lower.includes('lr') || key_lower.includes('learning')) return 0.001;
  if (key_lower.includes('batch')) return 32;
  if (key_lower.includes('dim') || key_lower.includes('hidden')) return 512;
  if (key_lower.includes('layer')) return 6;
  if (key_lower.includes('head')) return 8;
  if (key_lower.includes('dropout')) return 0.1;
  if (key_lower.includes('warmup')) return 1000;
  // Default: extract param name and use a sensible default
  const paramName = placeholder.slice(2, -1).toLowerCase();
  if (paramName.includes('dim')) return 256;
  if (paramName.includes('count') || paramName.includes('num')) return 4;
  return 'auto';
}

function shuffleFields(parent: SchematicGenome, intensity: number): SchematicGenome {
  const schematic = parent._schematic.map(section => ({
    ...section,
    fields: [...section.fields],
  }));

  for (const section of schematic) {
    if (section.fields.length <= 1) continue;
    // Fisher-Yates shuffle with probability proportional to intensity
    for (let i = section.fields.length - 1; i > 0; i--) {
      if (Math.random() < intensity) {
        const j = Math.floor(Math.random() * (i + 1));
        [section.fields[i], section.fields[j]] = [section.fields[j], section.fields[i]];
      }
    }
  }

  return { ...parent, _schematic: schematic };
}

function innovateSchematic(parent: SchematicGenome, externalIdea?: string): SchematicGenome {
  // Add a new section or field that wasn't in the parent
  const schematic = parent._schematic.map(section => ({
    ...section,
    fields: [...section.fields],
  }));

  const idea = externalIdea ?? getInnovationIdea();
  // Parse the idea as a potential new section
  const lines = idea.split('\n').filter(l => l.trim());
  if (lines.length > 0) {
    const newSection: SchematicSection = { name: 'Innovation', fields: [] };
    for (const line of lines.slice(0, 4)) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        newSection.fields.push({
          key: line.slice(0, colonIdx).trim(),
          value: line.slice(colonIdx + 1).trim(),
          mutationWeight: 1.0,
        });
      }
    }
    if (newSection.fields.length > 0) {
      schematic.push(newSection);
    }
  }

  return { ...parent, _schematic: schematic };
}

function getInnovationIdea(): string {
  const ideas = [
    'novel_attention: linear\ndynamic_linear: true\nstate_dim: 128',
    'ffn_type: mixture_of_experts\nnum_experts: 8\nexpert_capacity: 0.5',
    'memory_type: sparse\nsparse_ratio: 0.25\ncompression: lz4',
  ];
  return ideas[Math.floor(Math.random() * ideas.length)];
}

function simplifySchematic(parent: SchematicGenome, intensity: number): SchematicGenome {
  const schematic = parent._schematic.map(section => ({
    ...section,
    fields: section.fields.map(f => ({ ...f })),
  }));

  // Remove low-importance fields proportional to intensity
  const toRemove: [number, number][] = []; // [sectionIdx, fieldIdx]
  for (let si = 0; si < schematic.length; si++) {
    for (let fi = 0; fi < schematic[si].fields.length; fi++) {
      const weight = schematic[si].fields[fi].mutationWeight;
      if (weight < 0.5 && Math.random() < intensity) {
        toRemove.push([si, fi]);
      }
    }
  }

  for (const [si, fi] of toRemove.sort((a, b) => b[1] - a[1])) {
    schematic[si].fields.splice(fi, 1);
  }

  // Remove empty sections
  const filtered = schematic.filter(s => s.fields.length > 0);
  return { ...parent, _schematic: filtered.length > 0 ? filtered : parent._schematic };
}

/**
 * Crossover two schematics at a random boundary.
 * Returns a new SchematicGenome combining the first parent (sections up to split)
 * and the second parent (sections from split onward).
 */
export function crossoverSchematics(
  parentA: SchematicGenome,
  parentB: SchematicGenome,
  splitPoint?: number
): SchematicGenome {
  const sectionsA = parentA._schematic;
  const sectionsB = parentB._schematic;

  const split = splitPoint ?? Math.floor(Math.random() * (sectionsA.length + sectionsB.length));

  if (split < sectionsA.length) {
    return {
      ...parentA,
      _schematic: [
        ...sectionsA.slice(0, split),
        ...sectionsB,
      ],
      keyChanges: [`crossover at section ${split}`],
    };
  } else {
    return {
      ...parentB,
      _schematic: [
        ...sectionsA,
        ...sectionsB.slice(0, split - sectionsA.length),
      ],
      keyChanges: [`crossover at section ${split}`],
    };
  }
}

// =============================================================================
// Parent Pool
// =============================================================================

/**
 * ParentPool — maintains elite individuals across multiple generations.
 *
 * Unlike a single-generation population, the parent pool draws from
 * all evaluated individuals in the last N generations (configurable).
 * This lets elite genetic material survive across generations even if
 * a direct descendant doesn't make the cut in a given round.
 */
export class ParentPool {
  private entries: ParentPoolEntry[] = [];

  constructor(
    private maxGenerations: number = 3,
    private minFitness: number = 0.0,
  ) {}

  /**
   * Add an individual to the parent pool.
   * Only added if fitness exceeds minFitness threshold.
   */
  add(individual: Individual, fitness: number, currentGeneration: number): void {
    if (fitness < this.minFitness) return;

    this.entries.push({
      individual,
      fitness,
      age: currentGeneration - individual.gen,
    });

    this.prune(currentGeneration);
  }

  /**
   * Select a parent from the pool, weighted by fitness and recency.
   * Younger (lower age) and fitter individuals are more likely to be selected.
   */
  select(): Individual | null {
    if (this.entries.length === 0) return null;

    // Weight: fitness × recency_factor (age penalty)
    const weighted = this.entries.map(e => ({
      entry: e,
      weight: e.fitness * Math.max(0.1, 1 - e.age * 0.15), // 15% penalty per generation age
    }));

    const totalWeight = weighted.reduce((s, w) => s + w.weight, 0);
    let r = Math.random() * totalWeight;

    for (const { entry, weight } of weighted) {
      r -= weight;
      if (r <= 0) return entry.individual;
    }

    return weighted[weighted.length - 1].entry.individual;
  }

  /**
   * Select two distinct parents from the pool.
   */
  selectTwo(): [Individual, Individual] | [null, null] {
    const a = this.select();
    if (!a) return [null, null];

    // Second selection: exclude a, weighted same way
    const filtered = this.entries
      .filter(e => e.individual.id !== a.id)
      .map(e => ({
        entry: e,
        weight: e.fitness * Math.max(0.1, 1 - e.age * 0.15),
      }));

    if (filtered.length === 0) return [a, a]; // null second parent → use same (crossover with self)

    const totalWeight = filtered.reduce((s, w) => s + w.weight, 0);
    let r = Math.random() * totalWeight;
    for (const { entry, weight } of filtered) {
      r -= weight;
      if (r <= 0) return [a, entry.individual];
    }

    return [a, filtered[filtered.length - 1].entry.individual];
  }

  /** Remove entries older than maxGenerations */
  private prune(currentGeneration: number): void {
    this.entries = this.entries.filter(
      e => currentGeneration - e.individual.gen <= this.maxGenerations
    );
  }

  get size(): number {
    return this.entries.length;
  }
}

// =============================================================================
// Mutation Strategy Chooser
// // =============================================================================

/**
 * Default mutation strategy chooser — adapts strategy based on fitness landscape.
 *
 * High fitness (top 20%): exploration-biased — prefer INNOVATION, LARGE_MUTATION
 * Medium fitness: balanced — mix of SMALL_MUTATION, FEATURE_CROSSOVER, ABSTRACT
 * Low fitness: convergence-biased — prefer SMALL_MUTATION, SIMPLIFY to refine what works
 */
export function defaultChooseMutationStrategy(
  _parent: Individual,
  _parentFitness: number,
  _generation: number,
  _popBest: number
): { strategy: BreedingStrategy; intensity: number } {
  const relativeFitness = 0.5;

  const strategies: { s: BreedingStrategy; w: number }[] = [
    { s: BreedingStrategy.SMALL_MUTATION, w: relativeFitness > 0.8 ? 1 : 3 },
    { s: BreedingStrategy.LARGE_MUTATION, w: relativeFitness > 0.8 ? 3 : 1 },
    { s: BreedingStrategy.FEATURE_CROSSOVER, w: 2 },
    { s: BreedingStrategy.ABSTRACT, w: 1 },
    { s: BreedingStrategy.INSTANTIATE, w: 1 },
    { s: BreedingStrategy.SINGLE_POINT_CROSSOVER, w: 2 },
    { s: BreedingStrategy.SHUFFLE, w: 1 },
    { s: BreedingStrategy.INNOVATION, w: relativeFitness > 0.8 ? 4 : 1 },
    { s: BreedingStrategy.SIMPLIFY, w: relativeFitness < 0.4 ? 3 : 1 },
  ];

  const totalWeight = strategies.reduce((s, str) => s + str.w, 0);
  let r = Math.random() * totalWeight;
  let chosen = strategies[0].s;
  for (const { s, w } of strategies) {
    r -= w;
    if (r <= 0) { chosen = s; break; }
  }

  // Intensity: higher for low-fitness (explore more), lower for high-fitness (refine)
  const intensity = relativeFitness < 0.5
    ? 0.5 + Math.random() * 0.5
    : 0.2 + Math.random() * 0.4;

  return { strategy: chosen, intensity };
}

// =============================================================================
// Breeding Workflow
// =============================================================================

/**
 * Build a schematic-first breeding function suitable for use in EAConfig.mutate.
 *
 * Usage:
 * ```typescript
 * const config: EAConfig = {
 *   ...
 *   mutate: buildSchematicMutator(schematicConfig, parentPool),
 * };
 * ```
 */
export function buildSchematicMutator(
  schematicConfig: SchematicEAConfig,
  parentPool: ParentPool,
  chooseStrategy: (
    parent: Individual,
    fitness: number,
    generation: number,
    popBest: number
  ) => { strategy: BreedingStrategy; intensity: number } = defaultChooseMutationStrategy,
  popBestFitness: number = 0,
): (parent: Individual) => Promise<Individual> {
  return async (parent: Individual): Promise<Individual> => {
    const schematic = parent.genome._schematic as SchematicGenome | undefined;
    if (!schematic) {
      // Fallback: treat as free-text mutation
      return { ...parent, genome: { ...parent.genome, _text: (parent.genome._text ?? '') + '.' } };
    }

    const popBest = popBestFitness > 0 ? popBestFitness : parent.fitness ?? 0.5;
    const { strategy, intensity } = chooseStrategy(parent, parent.fitness ?? 0, parent.gen, popBest);

    let newSchematic: SchematicGenome;
    if (strategy === BreedingStrategy.FEATURE_CROSSOVER || strategy === BreedingStrategy.SINGLE_POINT_CROSSOVER) {
      // Crossover: need second parent from pool
      const [, secondParent] = parentPool.selectTwo();
      if (secondParent && (secondParent.genome as unknown as SchematicGenome)?._schematic) {
        const secondSchematic = secondParent.genome as unknown as SchematicGenome;
        if (strategy === BreedingStrategy.FEATURE_CROSSOVER) {
          // Feature-wise: pick best fields from each parent
          newSchematic = featureCrossover(schematic, secondSchematic);
        } else {
          newSchematic = crossoverSchematics(schematic, secondSchematic);
        }
      } else {
        newSchematic = schematic;
      }
    } else {
      newSchematic = await applyBreedingStrategy(strategy, schematic, schematicConfig, intensity);
    }

    return {
      ...parent,
      genome: { ...parent.genome, _schematic: newSchematic } as Genome,
      parents: [parent.id],
      breedMethod: 'mutate',
    };
  };
}

/** Feature-wise crossover: select best fields from two parents */
function featureCrossover(parentA: SchematicGenome, parentB: SchematicGenome): SchematicGenome {
  const sectionsA = parentA._schematic;
  const sectionsB = parentB._schematic;

  // For each section in A, choose the better field from A or B
  const merged: SchematicSection[] = [];

  for (const sectionA of sectionsA) {
    const sectionB = sectionsB.find(s => s.name === sectionA.name);
    if (!sectionB) {
      merged.push(sectionA);
      continue;
    }

    const mergedFields = sectionA.fields.map(fieldA => {
      const fieldB = sectionB.fields.find(f => f.key === fieldA.key);
      if (!fieldB) return fieldA;

      // Pick field with more specific value (non-generic)
      const aSpecific = !isGenericValue(fieldA.value);
      const bSpecific = !isGenericValue(fieldB.value);
      return aSpecific || (!bSpecific && Math.random() < 0.5) ? fieldA : fieldB;
    });

    merged.push({ name: sectionA.name, fields: mergedFields });
  }

  return { ...parentA, _schematic: merged, keyChanges: ['feature_crossover'] };
}

function isGenericValue(value: unknown): boolean {
  if (typeof value === 'string') {
    return value === 'auto' || value === 'default' || value.startsWith('${');
  }
  return false;
}

/**
 * Build a schematic-first crossover function for EAConfig.crossover.
 */
export function buildSchematicCrossover(
  __parentPool: ParentPool,
): (parentA: Individual, parentB: Individual) => Promise<Individual> {
  return async (parentA: Individual, parentB: Individual): Promise<Individual> => {
    const schA = parentA.genome._schematic as SchematicGenome | undefined;
    const schB = parentB.genome._schematic as SchematicGenome | undefined;

    if (!schA || !schB) {
      // Fallback: text crossover
      return {
        ...parentA,
        genome: {
          ...parentA.genome,
          _text: `${parentA.genome._text ?? ''} ${parentB.genome._text ?? ''}`.trim(),
        },
        parents: [parentA.id, parentB.id],
        breedMethod: 'crossover',
      };
    }

    const child = crossoverSchematics(schA, schB);

    return {
      ...parentA,
      genome: { ...parentA.genome, _schematic: child } as Genome,
      parents: [parentA.id, parentB.id],
      breedMethod: 'crossover',
    };
  };
}

/**
 * Build a schematic seed function that initializes from a YAML string.
 *
 * Usage:
 * ```typescript
 * const config: EAConfig = {
 *   seed: buildSchematicSeed('## Architecture\n  layers: 6\n  ...'),
 * };
 * ```
 */
export function buildSchematicSeed(
  yamlTemplate: string,
  variantCount: number = 1,
): (index: number) => Promise<Genome> {
  const baseSchematic = parseSchematic(yamlTemplate);

  return async (_index: number): Promise<Genome> => { // _index allows seeding variants
    if (variantCount <= 1) return { _schematic: baseSchematic._schematic };

    // Create variant by applying small mutations
    let schematic = baseSchematic;
    const variantNoise = Math.ceil(variantCount / 2);
    for (let v = 0; v < variantNoise; v++) {
      schematic = smallMutation(schematic, 0.3);
    }

    return { _schematic: schematic._schematic };
  };
}