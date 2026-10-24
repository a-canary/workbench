/**
 * Check: v2 stateful prompt shape.
 *
 * The whole v2 hypothesis is the message array: recent turns verbatim as real
 * conversation, older turns compacted into the graph buffer. If that shape
 * breaks, the A/B measures nothing.
 */
import assert from 'assert';
import { buildMessages } from './harness.js';

const BUF = '# context buffer @root=s ...';
const turn = i => ({ action: `{"tool":"bash","args":{"command":"echo ${i}"}}`, result: `{"success":true,"output":"${i}"}` });

// Cold start: no history, no buffer block, one ask for the next action.
{
  const m = buildMessages('do a thing', BUF, []);
  assert.deepEqual(m.map(x => x.role), ['system', 'user']);
  assert.ok(m[1].content.includes('Task: do a thing'));
  assert.ok(!m[1].content.includes('Earlier context'), 'no fog block when nothing is older');
  assert.ok(m[1].content.includes('Next action'));
}

// Under the window: every turn verbatim, alternating assistant/user, no fog.
{
  const turns = [turn(1), turn(2), turn(3)];
  const m = buildMessages('t', BUF, turns);
  assert.equal(m.length, 2 + turns.length * 2);
  assert.equal(m[2].role, 'assistant');
  assert.equal(m[2].content, turns[0].action);
  assert.equal(m[3].role, 'user');
  assert.ok(m[3].content.includes(turns[0].result));
  assert.ok(!m[1].content.includes('Earlier context'));
  assert.equal(m.at(-1).role, 'user');
}

// Over the window: prompt stays bounded, oldest turns drop out of the verbatim
// tail and the buffer stands in for them.
{
  const turns = Array.from({ length: 20 }, (_, i) => turn(i));
  const m = buildMessages('t', BUF, turns);
  assert.equal(m.length, 2 + 6 * 2, 'window caps the message count');
  assert.equal(m[2].content, turns[14].action, 'tail is the last 6 turns');
  assert.equal(m.at(-2).content, turns[19].action);
  assert.ok(m[1].content.includes('14 older turn(s)'));
  assert.ok(m[1].content.includes(BUF), 'older turns come in via the graph buffer');
  assert.ok(!m[1].content.includes(turns[0].result), 'older turns are not re-sent verbatim');
}

console.log('ok — v2 prompt shape (3 checks)');
