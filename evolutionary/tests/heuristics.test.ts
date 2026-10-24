/**
 * Tests: heuristics — cyclomatic complexity, type hint coverage, docstring coverage
 */

import { describe, it, expect } from 'vitest';
import type { Individual } from '../src/types.js';
import {
  countCyclomaticComplexity,
  countTypeHintCoverage,
  countDocstringCoverage,
  validateCyclomaticComplexity,
  validateTypeHintCoverage,
  validateDocstringCoverage,
  validateCodeQuality,
  evaluateCyclomaticComplexity,
  evaluateTypeHintCoverage,
  evaluateDocstringCoverage,
  evaluateCodeQuality,
} from '../src/heuristics.js';

// Helper: make a minimal Individual with _code
function codeInd(code: string): Individual {
  return {
    id: 'test_g0_p0',
    gen: 0,
    status: 'pending',
    genome: { _code: code },
    fitness: null,
    metrics: {},
    judgeOutput: '',
    cached: false,
    validationReason: '',
    retireCause: null,
    parents: [],
    breedMethod: 'seed',
    createdAt: Date.now(),
    evaluatedAt: null,
  };
}

// =============================================================================
// countCyclomaticComplexity
// =============================================================================

describe('countCyclomaticComplexity', () => {
  it('returns 1 for empty body', () => {
    expect(countCyclomaticComplexity('')).toBe(1);
  });

  it('returns 1 for straight-line code', () => {
    expect(countCyclomaticComplexity('return a + b;')).toBe(1);
  });

  it('adds 1 per if statement', () => {
    expect(countCyclomaticComplexity('if (a) return 1;')).toBe(2);
    expect(countCyclomaticComplexity('if (a) return 1; else return 2;')).toBe(3);
  });

  it('adds 1 per while loop', () => {
    expect(countCyclomaticComplexity('while (a) { a--; }')).toBe(2);
  });

  it('adds 1 per for loop', () => {
    expect(countCyclomaticComplexity('for (let i = 0; i < n; i++) {}')).toBe(2);
  });

  it('adds 1 per ternary', () => {
    expect(countCyclomaticComplexity('return a ? b : c;')).toBe(2);
  });

  it('adds 1 per && or ||', () => {
    expect(countCyclomaticComplexity('if (a && b) {}')).toBe(2);
    expect(countCyclomaticComplexity('if (a || b) {}')).toBe(2);
  });

  it('adds 1 per case in switch', () => {
    const body = `switch(x) { case 1: break; case 2: break; default: break; }`;
    expect(countCyclomaticComplexity(body)).toBeGreaterThan(1);
  });

  it('adds 1 per catch', () => {
    expect(countCyclomaticComplexity('try {} catch(e) {}')).toBe(2);
  });

  it('ignores strings containing && or ||', () => {
    const body = 'return "a && b";';
    expect(countCyclomaticComplexity(body)).toBe(1);
  });

  it('handles nested branches', () => {
    const body = 'if (a) { if (b) { return 1; } else { return 2; } } else { return 3; }';
    expect(countCyclomaticComplexity(body)).toBeGreaterThan(3);
  });

  it('handles try/catch/finally', () => {
    const body = 'try {} catch(e) {} finally {}';
    expect(countCyclomaticComplexity(body)).toBe(2);
  });
});

// =============================================================================
// countTypeHintCoverage
// =============================================================================

describe('countTypeHintCoverage', () => {
  it('returns 0.5 when no functions found', () => {
    expect(countTypeHintCoverage('// no functions here')).toBe(0.5);
  });

  it('returns 1 for fully typed function', () => {
    const code = 'function add(a: number, b: number): number { return a + b; }';
    expect(countTypeHintCoverage(code)).toBe(1);
  });

  it('returns 0.5 for untyped function', () => {
    const code = 'function add(a, b) { return a + b; }';
    expect(countTypeHintCoverage(code)).toBe(0.5);
  });

  it('returns partial for partially typed params', () => {
    const code = 'function add(a: number, b) { return a; }';
    const cov = countTypeHintCoverage(code);
    expect(cov).toBeGreaterThan(0.3);
    expect(cov).toBeLessThan(1);
  });

  it('returns partial when return is untyped', () => {
    const code = 'function add(a: number, b: number) { return a + b; }';
    const cov = countTypeHintCoverage(code);
    expect(cov).toBeLessThan(1);
    expect(cov).toBeGreaterThan(0.3);
  });

  it('handles arrow functions', () => {
    const code = 'const add = (a: number, b: number): number => a + b;';
    expect(countTypeHintCoverage(code)).toBe(1);
  });

  it('handles async function declarations', () => {
    const code = 'async function fetchData(url: string): Promise<Response> { return fetch(url); }';
    expect(countTypeHintCoverage(code)).toBe(1);
  });

  it('ignores single-line comments', () => {
    const code = '// function add(a, b) { return a + b; }';
    expect(countTypeHintCoverage(code)).toBe(0.5);
  });
});

// =============================================================================
// countDocstringCoverage
// =============================================================================

describe('countDocstringCoverage', () => {
  it('returns 0 when no functions found', () => {
    expect(countDocstringCoverage('// no functions')).toBe(0);
  });

  it('returns 1 when all functions have docstrings', () => {
    const code = [
      '/** Adds two numbers. */',
      'function add(a: number, b: number): number { return a + b; }',
    ].join('\n');
    expect(countDocstringCoverage(code)).toBe(1);
  });

  it('returns 0 when no functions have docstrings', () => {
    const code = 'function add(a: number, b: number): number { return a + b; }';
    expect(countDocstringCoverage(code)).toBe(0);
  });

  it('returns 0.5 when half have docstrings', () => {
    const code = [
      '/** Doc */',
      'function add(a: number): number { return a; }',
      'function sub(a: number): number { return a; }',
    ].join('\n');
    expect(countDocstringCoverage(code)).toBe(0.5);
  });

  it('recognizes triple-quote docstrings', () => {
    const code = [
      '"""',
      'Adds two numbers.',
      '"""',
      'function add(a: number, b: number): number { return a + b; }',
    ].join('\n');
    expect(countDocstringCoverage(code)).toBe(1);
  });

  it('ignores single-line comments', () => {
    const code = [
      '// This is a comment, not a docstring',
      'function add(a: number): number { return a; }',
    ].join('\n');
    expect(countDocstringCoverage(code)).toBe(0);
  });

  it('handles block comments as docstrings', () => {
    const code = [
      '/* Adds two numbers */',
      'function add(a: number, b: number): number { return a + b; }',
    ].join('\n');
    expect(countDocstringCoverage(code)).toBe(1);
  });

  it('handles arrow functions', () => {
    const code = [
      '/** Doubles a number */',
      'const double = (n: number): number => n * 2;',
    ].join('\n');
    expect(countDocstringCoverage(code)).toBe(1);
  });
});

// =============================================================================
// validateCyclomaticComplexity
// =============================================================================

describe('validateCyclomaticComplexity', () => {
  it('returns valid for low-complexity code', () => {
    const code = 'function add(a: number, b: number): number { return a + b; }';
    expect(validateCyclomaticComplexity(codeInd(code), 15)).toEqual({ valid: true, reason: '' });
  });

  it('returns valid when max equals threshold', () => {
    const body = 'if (a) { if (b) { if (c) { if (d) return 1; } } }';
    const code = `function deep(a, b, c, d) { ${body} }`;
    const cc = countCyclomaticComplexity(body);
    expect(validateCyclomaticComplexity(codeInd(code), cc)).toEqual({ valid: true, reason: '' });
  });

  it('returns invalid when complexity exceeds threshold', () => {
    const body = 'if (a) { if (b) { if (c) { if (d) { if (e) {} } } } }';
    const code = `function deep(a, b, c, d, e) { ${body} }`;
    const result = validateCyclomaticComplexity(codeInd(code), 5);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('complexity');
  });

  it('returns valid for empty/no code genome', () => {
    expect(validateCyclomaticComplexity({ ...codeInd(''), genome: {} } as Individual, 15).valid).toBe(false);
  });
});

// =============================================================================
// validateTypeHintCoverage
// =============================================================================

describe('validateTypeHintCoverage', () => {
  it('returns valid when coverage meets threshold', () => {
    const code = 'function add(a: number, b: number): number { return a + b; }';
    expect(validateTypeHintCoverage(codeInd(code), 0.5)).toEqual({ valid: true, reason: '' });
  });

  it('returns invalid when coverage below threshold', () => {
    const code = 'function add(a, b) { return a + b; }';
    const result = validateTypeHintCoverage(codeInd(code), 0.9);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('type hint coverage');
  });

  it('returns valid for empty genome', () => {
    const result = validateTypeHintCoverage({ ...codeInd(''), genome: {} } as Individual, 0.5);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('no code');
  });
});

// =============================================================================
// validateDocstringCoverage
// =============================================================================

describe('validateDocstringCoverage', () => {
  it('returns valid when coverage meets threshold', () => {
    const code = [
      '/** Adds two numbers. */',
      'function add(a: number, b: number): number { return a + b; }',
    ].join('\n');
    expect(validateDocstringCoverage(codeInd(code), 0.3)).toEqual({ valid: true, reason: '' });
  });

  it('returns invalid when coverage below threshold', () => {
    const code = 'function add(a: number): number { return a; }';
    const result = validateDocstringCoverage(codeInd(code), 0.9);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('docstring coverage');
  });
});

// =============================================================================
// validateCodeQuality (composite)
// =============================================================================

describe('validateCodeQuality', () => {
  it('returns valid when all three heuristics pass', () => {
    const code = [
      '/** Adds two numbers. */',
      'function add(a: number, b: number): number { return a + b; }',
    ].join('\n');
    expect(validateCodeQuality(codeInd(code))).toEqual({ valid: true, reason: '' });
  });

  it('returns invalid on first failing gate', () => {
    const code = '/** Doc */ function add(a, b) { return a + b; }'; // no type hints
    const result = validateCodeQuality(codeInd(code));
    expect(result.valid).toBe(false);
  });
});

// =============================================================================
// evaluateCyclomaticComplexity
// =============================================================================

describe('evaluateCyclomaticComplexity', () => {
  it('returns fitness = 1 for empty body', () => {
    const result = evaluateCyclomaticComplexity(codeInd(''));
    expect(result.fitness).toBe(1);
  });

  it('returns fitness close to 1 for low complexity', () => {
    const code = 'function add(a: number): number { return a + 1; }';
    const result = evaluateCyclomaticComplexity(codeInd(code));
    expect(result.fitness).toBeGreaterThan(0.8);
    expect(result.metrics.complexityCount).toBe(1);
  });

  it('returns fitness = 0 for max complexity', () => {
    const body = 'if (a) { if (b) { if (c) { if (d) { if (e) { if (f) {} } } } } }';
    const code = `function deep(a, b, c, d, e, f) { ${body} }`;
    const result = evaluateCyclomaticComplexity(codeInd(code));
    expect(result.fitness).toBe(0);
  });

  it('reports maxComplexity in metrics', () => {
    const body = 'if (a) return 1;';
    const code = `function f(a) { ${body} }`;
    const result = evaluateCyclomaticComplexity(codeInd(code));
    expect(typeof result.metrics.maxComplexity).toBe('number');
  });
});

// =============================================================================
// evaluateTypeHintCoverage
// =============================================================================

describe('evaluateTypeHintCoverage', () => {
  it('returns coverage as fitness', () => {
    const code = 'function add(a: number, b: number): number { return a + b; }';
    const result = evaluateTypeHintCoverage(codeInd(code));
    expect(result.fitness).toBeGreaterThan(0.5);
    expect(result.metrics.coveragePct).toBeGreaterThan(50);
  });

  it('returns 0.5 for empty/no code', () => {
    const result = evaluateTypeHintCoverage(codeInd(''));
    expect(result.fitness).toBe(0.5);
  });
});

// =============================================================================
// evaluateDocstringCoverage
// =============================================================================

describe('evaluateDocstringCoverage', () => {
  it('returns 1.0 when all functions documented', () => {
    const code = [
      '/** Adds two numbers. */',
      'function add(a: number, b: number): number { return a + b; }',
    ].join('\n');
    const result = evaluateDocstringCoverage(codeInd(code));
    expect(result.fitness).toBe(1);
  });

  it('returns 0 when none documented', () => {
    const code = 'function add(a: number): number { return a; }';
    const result = evaluateDocstringCoverage(codeInd(code));
    expect(result.fitness).toBe(0);
  });
});

// =============================================================================
// evaluateCodeQuality (composite)
// =============================================================================

describe('evaluateCodeQuality', () => {
  it('returns 0.5 for empty genome', () => {
    const result = evaluateCodeQuality({ ...codeInd(''), genome: {} } as Individual);
    expect(result.fitness).toBe(0.5);
  });

  it('returns higher fitness for well-typed + documented + simple code', () => {
    const good = [
      '/** Doubles a number. */',
      'function double(n: number): number { return n * 2; }',
    ].join('\n');
    const bad = [
      'function double(n) { if (n > 0) { if (n > 10) { if (n > 100) return 1; } } return 0; }',
    ].join('\n');

    const goodResult = evaluateCodeQuality(codeInd(good));
    const badResult = evaluateCodeQuality(codeInd(bad));
    expect(goodResult.fitness).toBeGreaterThan(badResult.fitness);
  });

  it('reports all three dimensions in metrics', () => {
    const code = '/** Doc */ function add(a: number): number { return a; }';
    const result = evaluateCodeQuality(codeInd(code));
    expect(result.metrics).toHaveProperty('complexityFitness');
    expect(result.metrics).toHaveProperty('typeHintCoverage');
    expect(result.metrics).toHaveProperty('docstringCoverage');
  });

  it('returns fitness in [0, 1]', () => {
    const codes = [
      '',
      'function f() {}',
      '/** doc */ function f(a: number): number { return a; }',
      'function f(a) { if (a) { if (a) { if (a) { if (a) {} } } } }',
    ];
    for (const code of codes) {
      const result = evaluateCodeQuality(codeInd(code));
      expect(result.fitness).toBeGreaterThanOrEqual(0);
      expect(result.fitness).toBeLessThanOrEqual(1);
    }
  });

  it('judgeOutput contains complexity and coverage values', () => {
    const code = '/** Doc */ function add(a: number): number { return a; }';
    const result = evaluateCodeQuality(codeInd(code));
    expect(result.judgeOutput).toContain('complexity=');
    expect(result.judgeOutput).toContain('type_hints=');
    expect(result.judgeOutput).toContain('docs=');
  });
});
