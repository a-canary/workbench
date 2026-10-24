/**
 * Heuristics — Programmatic validate/evaluate callbacks for code quality EA.
 *
 * Three validators (gate before expensive LLM evaluation):
 *   - cyclomaticComplexity: CFG branch count, upper-bounded
 *   - typeHintCoverage:    fraction of function params + returns typed
 *   - docstringCoverage:   fraction of top-level defs with docstrings
 *
 * Three evaluators (fitness signals for code evolution):
 *   - evaluateCyclomaticComplexity: lower complexity → higher fitness
 *   - evaluateTypeHintCoverage:     higher coverage → higher fitness
 *   - evaluateDocstringCoverage:   higher coverage → higher fitness
 *
 * One composite evaluator:
 *   - evaluateCodeQuality: weighted combo of all three
 *
 * All functions are pure (no I/O) so they run fast as pre-evolution gates.
 */

import type { Individual, ValidationResult, FitnessResult } from './types.js';

// =============================================================================
// Cyclomatic Complexity
// =============================================================================

/**
 * Count CFG branch points in a function body.
 * CC = 1 + #decision_points (if/else/while/for/case/catch/ternary).
 * Logical && and || do NOT create new CFG paths (they short-circuit
 * within a single decision), so they are not counted.
 */
export function countCyclomaticComplexity(body: string): number {
  let s = stripStringsAndComments(body);
  let count = 1; // baseline
  const tokens: RegExp[] = [
    /\bif\b/g,       // if
    /\belse\b/g,     // else (each else is a branch)
    /\bcase\b/g,     // switch case
    /\bdefault\b/g, // switch default
    /\bwhile\b/g,    // while loop
    /\bfor\b/g,      // for loop
    /\bcatch\b/g,   // try/catch
    /\?\s*[^=]/g,   // ternary (not ??)
  ];
  for (const re of tokens) {
    const m = s.match(re);
    if (m) count += m.length;
  }
  return count;
}

// =============================================================================
// Type Hint Coverage
// =============================================================================

/**
 * Fraction of function parameters + return types that are annotated.
 * Handles:
 *   - function foo(a: T, b: U): R {}
 *   - function foo(a, b) {}                (untyped)
 *   - const foo = (a: T): R => {}
 *   - async function foo(a: T): Promise<R> {}
 *
 * Coverage = (typed_params / total_params + (has_return_type ? 1 : 0)) / 2
 */
export function countTypeHintCoverage(src: string): number {
  let totalParams = 0;
  let typedParams = 0;
  let hasReturnType = false;

  const clean = stripComments(src);

  // ── 1. Function declarations: function foo(params): ReturnType {}
  for (const m of clean.matchAll(
    /function\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*\(([^)]*)\)\s*(?::\s*([^{][^;{]*?))?\s*\{/g
  )) {
    const params = m[1] ?? '';
    const retType = m[2] ?? '';
    const pCount = countParams(params);
    totalParams += pCount;
    typedParams += countTypedParams(params);
    hasReturnType = hasReturnType || looksLikeType(retType);
  }

  // ── 2. Arrow / const assignments: const foo = (params): ReturnType => body
  // Match: const foo = (params): ReturnType =>
  for (const m of clean.matchAll(
    /const\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*=\s*\(([^)]*)\)\s*:\s*([a-zA-Z_$][a-zA-Z0-9_$\s<>\[\]|&]*?)\s*=>/g
  )) {
    const params = m[1] ?? '';
    const retType = m[2] ?? '';
    const pCount = countParams(params);
    totalParams += pCount;
    typedParams += countTypedParams(params);
    hasReturnType = hasReturnType || looksLikeType(retType);
  }

  // ── 3. Async function declarations: async function foo(params): ReturnType {}
  for (const m of clean.matchAll(
    /async\s+function\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*\(([^)]*)\)\s*(?::\s*([^{][^;{]*?))?\s*\{/g
  )) {
    const params = m[1] ?? '';
    const retType = m[2] ?? '';
    const pCount = countParams(params);
    totalParams += pCount;
    typedParams += countTypedParams(params);
    hasReturnType = hasReturnType || looksLikeType(retType);
  }

  if (totalParams === 0 && !hasReturnType) return 0.5; // no functions found
  if (totalParams === 0) return hasReturnType ? 1.0 : 0.0;

  const paramScore = typedParams / totalParams;
  const returnScore = hasReturnType ? 1 : 0;
  return Math.round(((paramScore + returnScore) / 2) * 1000) / 1000;
}

function countParams(params: string): number {
  if (!params.trim()) return 0;
  return params.split(',').filter(p => p.trim()).length;
}

function countTypedParams(params: string): number {
  if (!params.trim()) return 0;
  return params.split(',').filter(p => p.includes(':')).length;
}

/** True if s looks like a TypeScript return type annotation. */
function looksLikeType(s: string): boolean {
  if (!s) return false;
  const t = s.trim();
  if (!t) return false;
  // Reject if it starts with a JS statement keyword
  if (/^(return|throw|if|else|while|for|switch|case|try|catch|finally|do|break|continue|yield|await|async|function|class|interface|enum|import|export|const|let|var|type|namespace|module|declare|abstract|public|private|protected|static|readonly|override)/.test(t)) {
    return false;
  }
  // Accept if it starts with a letter or contains < (generic)
  return /^[a-zA-Z]/.test(t) || t.includes('<');
}

// =============================================================================
// Docstring Coverage
// =============================================================================

/**
 * Fraction of top-level function defs that have a docstring.
 * Returns 0 when no functions found.
 */
export function countDocstringCoverage(src: string): number {
  const funcs = findTopLevelFunctions(src);
  if (funcs.length === 0) return 0;

  let covered = 0;
  for (const { startIdx } of funcs) {
    if (hasDocstringBefore(src, startIdx)) covered++;
  }
  return Math.round((covered / funcs.length) * 1000) / 1000;
}

/** Find top-level function names and their starting line indices. */
function findTopLevelFunctions(src: string): { name: string; startIdx: number }[] {
  const results: { name: string; startIdx: number }[] = [];
  const linesArr = src.split(/\r?\n/);

  for (let i = 0; i < linesArr.length; i++) {
    const l = linesArr[i];
    // Skip indented lines (not top-level)
    if (/^\s/.test(l)) continue;

    // function declarations
    const fnMatch = l.match(/^(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
    if (fnMatch) {
      results.push({ name: fnMatch[1], startIdx: i });
      continue;
    }

    // const/let/var arrow functions (single-line, top-level)
    const arrowMatch = l.match(/^(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s+)?\([^)]*\)[^=]*=>/);
    if (arrowMatch) {
      results.push({ name: arrowMatch[1], startIdx: i });
    }
  }
  return results;
}

/** Check if a docstring or block comment appears on the 1-2 lines before the function. */
function hasDocstringBefore(src: string, funcLineIdx: number): boolean {
  const linesArr = src.split(/\r?\n/);
  for (let i = funcLineIdx - 1; i >= 0 && i >= funcLineIdx - 3; i--) {
    const l = linesArr[i].trim();
    if (!l) continue;
    // Single-line comment is not a docstring
    if (l.startsWith('//')) continue;
    // Block comment or string literal → docstring
    if (l.startsWith('/*') || l.startsWith('*') || l.startsWith('"') || l.startsWith("'") || l.startsWith('`')) {
      return true;
    }
    // Another function keyword means no docstring here
    if (/^(?:export\s+)?(?:async\s+)?function\b/.test(l) || /^(?:export\s+)?(?:const|let|var)\b/.test(l)) {
      break;
    }
    // Any other code line means no docstring
    if (!l.startsWith('/*') && !l.startsWith('*') && !l.startsWith('"') && !l.startsWith("'") && !l.startsWith('`')) {
      break;
    }
  }
  return false;
}

// =============================================================================
// Helpers
// =============================================================================

/** Strip string literals and comments from a code body (for CC counting). */
function stripStringsAndComments(body: string): string {
  let s = body.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, '``');
  s = s.replace(/\/\/[^\n]*/g, '');
  s = s.replace(/\/\*[^]*?\*\//g, '');
  return s;
}

/** Strip single-line and block comments from source. */
function stripComments(src: string): string {
  let s = src.replace(/\/\/[^\n]*/g, '');
  s = s.replace(/\/\*[^]*?\*\//g, '');
  return s;
}

/** Extract code string from a genome (_code or _text fields). */
function extractCode(ind: Individual): string {
  if (typeof (ind.genome as Record<string, unknown>)._code === 'string') {
    return (ind.genome as Record<string, unknown>)._code as string;
  }
  if (typeof ind.genome._text === 'string') return ind.genome._text;
  return '';
}

/** Extract all top-level function bodies with their CC. */
function allFunctionBodies(src: string): { name: string; complexity: number }[] {
  const clean = stripComments(src);
  const results: { name: string; complexity: number }[] = [];

  // function declarations
  for (const m of clean.matchAll(
    /function\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/g
  )) {
    const fnStr = m[0];
    const bodyStart = m.index + fnStr.length;
    // Find the body end
    let depth = 1;
    let i = bodyStart;
    while (i < clean.length && depth > 0) {
      if (clean[i] === '{') depth++;
      else if (clean[i] === '}') depth--;
      i++;
    }
    const body = clean.slice(bodyStart, i - 1);
    const nameMatch = fnStr.match(/function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
    results.push({ name: nameMatch?.[1] ?? 'fn', complexity: countCyclomaticComplexity(body) });
  }

  // Arrow function bodies (const foo = (params): RetType => { body })
  for (const m of clean.matchAll(
    /const\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*=\s*\([^)]*\)[^=]*=>/g
  )) {
    const fnStr = m[0];
    const bodyStart = m.index + fnStr.length;
    if (clean[bodyStart] === '{') {
      let depth = 1; let i = bodyStart + 1;
      while (i < clean.length && depth > 0) {
        if (clean[i] === '{') depth++;
        else if (clean[i] === '}') depth--;
        i++;
      }
      const body = clean.slice(bodyStart + 1, i - 1);
      const nameMatch = fnStr.match(/const\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
      results.push({ name: nameMatch?.[1] ?? 'fn', complexity: countCyclomaticComplexity(body) });
    }
  }

  return results;
}

// =============================================================================
// EA Callbacks — Validators
// =============================================================================

const MAX_CC = 15;

/** Reject if any function exceeds MAX_CC cyclomatic complexity. */
export function validateCyclomaticComplexity(ind: Individual, maxCC = MAX_CC): ValidationResult {
  const src = extractCode(ind);
  if (!src) return { valid: false, reason: 'no code in genome' };

  const bodies = allFunctionBodies(src);
  if (bodies.length === 0) return { valid: true, reason: 'no functions found' };

  for (const { name, complexity } of bodies) {
    if (complexity > maxCC) {
      return { valid: false, reason: `function "${name}" has complexity ${complexity} > ${maxCC}` };
    }
  }
  return { valid: true, reason: '' };
}

/** Reject if type hint coverage is below threshold. */
export function validateTypeHintCoverage(ind: Individual, minCoverage = 0.5): ValidationResult {
  const src = extractCode(ind);
  if (!src) return { valid: false, reason: 'no code in genome' };

  const coverage = countTypeHintCoverage(src);
  if (coverage < minCoverage) {
    return { valid: false, reason: `type hint coverage ${(coverage * 100).toFixed(1)}% < ${(minCoverage * 100).toFixed(1)}%` };
  }
  return { valid: true, reason: '' };
}

/** Reject if docstring coverage is below threshold. */
export function validateDocstringCoverage(ind: Individual, minCoverage = 0.3): ValidationResult {
  const src = extractCode(ind);
  if (!src) return { valid: false, reason: 'no code in genome' };

  const coverage = countDocstringCoverage(src);
  if (coverage < minCoverage) {
    return { valid: false, reason: `docstring coverage ${(coverage * 100).toFixed(1)}% < ${(minCoverage * 100).toFixed(1)}%` };
  }
  return { valid: true, reason: '' };
}

/** All three gates combined. */
export function validateCodeQuality(ind: Individual): ValidationResult {
  const src = extractCode(ind);
  if (!src) return { valid: false, reason: 'no code in genome' };

  const cc = validateCyclomaticComplexity(ind);
  if (!cc.valid) return cc;

  const th = validateTypeHintCoverage(ind);
  if (!th.valid) return th;

  const dc = validateDocstringCoverage(ind);
  if (!dc.valid) return dc;

  return { valid: true, reason: '' };
}

// =============================================================================
// EA Callbacks — Evaluators
// =============================================================================

const MAX_CC_FITNESS = 20; // complexity ≥ this → fitness 0

/** Lower CC → higher fitness. Fitness = 1 - maxCC / MAX_CC_FITNESS. */
export function evaluateCyclomaticComplexity(
  ind: Individual,
  maxForZero = MAX_CC_FITNESS
): FitnessResult {
  const src = extractCode(ind);
  const bodies = src ? allFunctionBodies(src) : [];

  const maxCC = bodies.length > 0
    ? Math.max(...bodies.map(b => b.complexity))
    : 0;

  const fitness = Math.max(0, Math.min(1, 1 - maxCC / maxForZero));

  return {
    fitness: Math.round(fitness * 1000) / 1000,
    metrics: { maxCC, complexityCount: bodies.length, complexities: bodies },
    judgeOutput:
      bodies.length > 0
        ? `max=${maxCC} fns=${bodies.length} ${JSON.stringify(bodies.map(b => `${b.name}:${b.complexity}`))}`
        : 'no functions found',
  };
}

/** Type hint coverage as fitness [0..1]. */
export function evaluateTypeHintCoverage(ind: Individual): FitnessResult {
  const src = extractCode(ind);
  const coverage = src ? countTypeHintCoverage(src) : 0.5;

  return {
    fitness: coverage,
    metrics: { coverage, coveragePct: Math.round(coverage * 100) },
    judgeOutput: `type_hint_coverage=${(coverage * 100).toFixed(1)}%`,
  };
}

/** Docstring coverage as fitness [0..1]. */
export function evaluateDocstringCoverage(ind: Individual): FitnessResult {
  const src = extractCode(ind);
  const coverage = src ? countDocstringCoverage(src) : 0;

  return {
    fitness: coverage,
    metrics: { coverage, coveragePct: Math.round(coverage * 100) },
    judgeOutput: `docstring_coverage=${(coverage * 100).toFixed(1)}%`,
  };
}

/**
 * Weighted composite: 40% CC fitness + 30% type hints + 30% docs.
 * CC fitness = 1 - maxCC / MAX_CC_FITNESS.
 */
export function evaluateCodeQuality(ind: Individual): FitnessResult {
  const src = extractCode(ind);
  const bodies = src ? allFunctionBodies(src) : [];
  const maxCC = bodies.length > 0 ? Math.max(...bodies.map(b => b.complexity)) : 0;
  const ccFitness = Math.max(0, 1 - maxCC / MAX_CC_FITNESS);
  const typeHintCoverage = src ? countTypeHintCoverage(src) : 0.5;
  const docCoverage = src ? countDocstringCoverage(src) : 0;

  const fitness =
    0.40 * ccFitness +
    0.30 * typeHintCoverage +
    0.30 * docCoverage;

  return {
    fitness: Math.round(fitness * 1000) / 1000,
    metrics: {
      complexityFitness: ccFitness,
      typeHintCoverage,
      docstringCoverage: docCoverage,
      maxCC,
      typeHintPct: Math.round(typeHintCoverage * 100),
      docstringPct: Math.round(docCoverage * 100),
    },
    judgeOutput:
      `complexity=${maxCC} type_hints=${(typeHintCoverage * 100).toFixed(0)}% ` +
      `docs=${(docCoverage * 100).toFixed(0)}% fitness=${(fitness * 100).toFixed(1)}%`,
  };
}
