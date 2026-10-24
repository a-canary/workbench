/**
 * TDD tests for the v3 fill-to-quality-window buffer budget.
 *
 * Tests the real computeBudget from harness.js (not a local copy):
 *   budget = max(0, fillFrac x qualityWindow - (system + task + recent turns))
 */

import {
  computeBudget,
  estTokens,
  DEFAULT_QUALITY_WINDOW,
  DEFAULT_FILL_FRAC,
  DEFAULT_MAX_DEPTH,
} from './harness.js';

let passed = 0;
let failed = 0;

function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`  ok - ${name}`);
  } else {
    failed++;
    console.error(`  FAIL - ${name}`);
  }
}

console.log('=== v3 budget compute (fill-to-quality-window) ===\n');

// 1. No history: budget = fillFrac x qualityWindow minus the static
//    reservation (system + task). Defaults: 0.75 x 16384 = 12288 fill target.
{
  const b = computeBudget('do the thing', [], DEFAULT_QUALITY_WINDOW, DEFAULT_FILL_FRAC);
  const reservation = estTokens('do the thing'); // system prompt reserved separately inside
  check('defaults: budget is the fill target minus reservation (<= 0.75 x window)', b <= Math.floor(0.75 * DEFAULT_QUALITY_WINDOW));
  check('defaults: budget is positive and large (>= 10k for a short task)', b >= 10000);
  check('fill target scales with qualityWindow', computeBudget('x', [], 32768, 0.75) > computeBudget('x', [], 16384, 0.75));
  check('fill target scales with fillFrac', computeBudget('x', [], 16384, 0.5) < computeBudget('x', [], 16384, 0.75));
}

// 2. Reservation grows with task length and recent turns.
{
  const short = computeBudget('x', [], 16384, 0.75);
  const longTask = computeBudget('x'.repeat(16000), [], 16384, 0.75);
  check('longer task reserves more (budget shrinks)', longTask < short);

  const noTurns = computeBudget('x', [], 16384, 0.75);
  const withTurns = computeBudget('x', Array.from({ length: 6 }, (_, i) => ({ action: `{"tool":"bash","args":{"command":"cmd${i}"}}`, result: 'r'.repeat(400) })), 16384, 0.75);
  check('recent turns reserve more (budget shrinks)', withTurns < noTurns);
}

// 3. Floor at 0 — budget never negative, even with a tiny window.
{
  check('tiny window floors at 0', computeBudget('x'.repeat(100000), [], 512, 0.75) === 0);
  const b = computeBudget('x'.repeat(100000), Array.from({ length: 6 }, () => ({ action: 'a'.repeat(1000), result: 'r'.repeat(1000) })), 1024, 0.75);
  check('huge reservation floors at 0 (not negative)', b === 0);
}

// 4. Defaults are the pre-registered calibration values.
{
  check('DEFAULT_QUALITY_WINDOW = 16384 (Bonsai-27B initial calibration)', DEFAULT_QUALITY_WINDOW === 16384);
  check('DEFAULT_FILL_FRAC = 0.75', DEFAULT_FILL_FRAC === 0.75);
  check('DEFAULT_MAX_DEPTH = 5 (unchanged from v2)', DEFAULT_MAX_DEPTH === 5);
}

// 5. estTokens is a chars/4 ceiling — monotone and bounded.
{
  check('estTokens empty = 0', estTokens('') === 0);
  check('estTokens 4000 chars = 1000', estTokens('a'.repeat(4000)) === 1000);
  check('estTokens monotone', estTokens('a'.repeat(100)) <= estTokens('a'.repeat(200)));
}

console.log(`\n${failed === 0 ? 'All' : `${failed} FAILED, ${passed} passed`}: budget compute tests`);
process.exit(failed === 0 ? 0 : 1);
