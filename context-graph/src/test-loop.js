/**
 * Test: context-graph loop runs end-to-end.
 *
 * Acceptance criteria:
 * - One full run completes (4 iterations, 4 tool tasks)
 * - Graph nodes >= 8 (session + 4 tool calls + 4 tool results)
 * - Graph edges >= 8 (session -> events)
 * - Transcript contains graph+location markers (e.g., [d0 c=...])
 */

import { runLoop } from './loop.js';

async function testLoop() {
  console.log('Running context-graph loop test...\n');

  const result = await runLoop();

  console.log('\n--- Test Assertions ---');
  let passed = 0;
  let failed = 0;

  // 1. Loop completes
  if (result.success) {
    console.log('✓ Loop completed successfully');
    passed++;
  } else {
    console.log('✗ Loop did not complete');
    failed++;
  }

  // 2. Iterations ran
  if (result.iterations >= 4) {
    console.log(`✓ Iterations: ${result.iterations} (expected >= 4)`);
    passed++;
  } else {
    console.log(`✗ Iterations: ${result.iterations} (expected >= 4)`);
    failed++;
  }

  // 3. Graph has nodes
  if (result.nodeCount >= 8) {
    console.log(`✓ Graph nodes: ${result.nodeCount} (expected >= 8)`);
    passed++;
  } else {
    console.log(`✗ Graph nodes: ${result.nodeCount} (expected >= 8)`);
    failed++;
  }

  // 4. Graph has edges
  if (result.edgeCount >= 8) {
    console.log(`✓ Graph edges: ${result.edgeCount} (expected >= 8)`);
    passed++;
  } else {
    console.log(`✗ Graph edges: ${result.edgeCount} (expected >= 8)`);
    failed++;
  }

  // 5. Transcript contains graph markers
  const hasGraphMarkers = /\[d\d+ c=/.test(result.transcript);
  if (hasGraphMarkers) {
    console.log('✓ Transcript contains graph location markers (e.g., [d0 c=...])');
    passed++;
  } else {
    console.log('✗ Transcript missing graph location markers');
    failed++;
  }

  // 6. Transcript shows context buffer
  const hasBuffer = /# context buffer @root=/.test(result.transcript);
  if (hasBuffer) {
    console.log('✓ Transcript shows context buffer extraction');
    passed++;
  } else {
    console.log('✗ Transcript missing context buffer');
    failed++;
  }

  // 7. Transcript shows tool execution
  const hasTools = /Tool call:/.test(result.transcript);
  if (hasTools) {
    console.log('✓ Transcript shows tool execution');
    passed++;
  } else {
    console.log('✗ Transcript missing tool execution');
    failed++;
  }

  console.log(`\n--- Summary ---`);
  console.log(`Passed: ${passed}/7`);
  console.log(`Failed: ${failed}/7`);

  if (failed === 0) {
    console.log('\n✓ All tests passed!');
    return true;
  } else {
    console.log(`\n✗ ${failed} test(s) failed.`);
    return false;
  }
}

const success = await testLoop();
process.exit(success ? 0 : 1);
