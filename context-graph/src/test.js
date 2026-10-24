import { ContextGraphStore } from './store.js';
import { extract } from './extract.js';

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
};

function testNodeWrite() {
  const store = new ContextGraphStore();
  const location = {
    parent_chain: ['root'],
    depth: 0,
    cluster_id: 'main'
  };

  const node = store.writeNode('n1', 'test content', ['tag1', 'tag2'], location);
  assert(node.id === 'n1', 'Node id matches');
  assert(node.content === 'test content', 'Node content matches');
  assert(node.tags.length === 2, 'Node tags count matches');
  assert(store.nodeCount() === 1, 'Store has 1 node');

  const read = store.readNode('n1');
  assert(read !== undefined, 'Node can be read back');
  assert(read.location.cluster_id === 'main', 'Location persists');
}

function testEdgeWrite() {
  const store = new ContextGraphStore();
  const location = {
    parent_chain: ['root', 'n1'],
    depth: 1,
    cluster_id: 'edges'
  };

  store.writeNode('n1', 'source', [], location);
  store.writeNode('n2', 'dest', [], location);

  const edge = store.writeEdge('n1', 'n2', 'references', location);
  assert(edge.src === 'n1', 'Edge src matches');
  assert(edge.dst === 'n2', 'Edge dst matches');
  assert(edge.label === 'references', 'Edge label matches');
  assert(store.edgeCount() === 1, 'Store has 1 edge');

  const fromN1 = store.readEdgesFrom('n1');
  assert(fromN1.length === 1, 'readEdgesFrom returns 1 edge');
  assert(fromN1[0].dst === 'n2', 'readEdgesFrom returns correct edge');

  const toN2 = store.readEdgesTo('n2');
  assert(toN2.length === 1, 'readEdgesTo returns 1 edge');
}

function testLocationTracking() {
  const store = new ContextGraphStore();

  const loc1 = {
    parent_chain: ['root'],
    depth: 0,
    cluster_id: 'c1'
  };

  const loc2 = {
    parent_chain: ['root', 'n1'],
    depth: 1,
    cluster_id: 'c2'
  };

  const n1 = store.writeNode('n1', 'content1', [], loc1);
  const n2 = store.writeNode('n2', 'content2', [], loc2);

  assert(n1.location.cluster_id === 'c1', 'First node has correct location');
  assert(n2.location.cluster_id === 'c2', 'Second node has different location');
  assert(n2.location.parent_chain.length === 2, 'Second node has deeper parent chain');
}

function testIdempotentRewrite() {
  const store = new ContextGraphStore();
  const loc = { parent_chain: ['root'], depth: 0, cluster_id: 'c1' };

  store.writeNode('n1', 'content1', ['a'], loc);
  const again = store.writeNode('n1', 'content1', ['a'], loc);
  assert(again.content === 'content1', 'Identical re-write is a no-op');
  assert(store.nodeCount() === 1, 'Re-write does not duplicate');

  try {
    store.writeNode('n1', 'DIFFERENT', ['a'], loc);
    assert(false, 'Should reject conflicting re-write');
  } catch (e) {
    assert(e.message.includes('different content'), 'Rejects conflicting re-write');
  }
}

function testValidation() {
  const store = new ContextGraphStore();
  const goodLocation = { parent_chain: ['root'], depth: 0, cluster_id: 'c1' };

  // Empty id
  try {
    store.writeNode('', 'content', [], goodLocation);
    assert(false, 'Should reject empty id');
  } catch (e) {
    assert(e.message.includes('non-empty string'), 'Rejects empty id');
  }

  // Bad location
  try {
    store.writeNode('n1', 'content', [], { parent_chain: ['root'], depth: 0 });
    assert(false, 'Should reject incomplete location');
  } catch (e) {
    assert(e.message.includes('cluster_id'), 'Rejects incomplete location');
  }

  // Negative depth
  try {
    store.writeNode('n1', 'content', [], { parent_chain: ['root'], depth: -1, cluster_id: 'c1' });
    assert(false, 'Should reject negative depth');
  } catch (e) {
    assert(e.message.includes('non-negative'), 'Rejects negative depth');
  }
}


// --- extractor (fog-of-war) ---------------------------------------------

const loc = (depth, cluster = 'main') => ({ parent_chain: [], depth, cluster_id: cluster });

/**
 * Fixture:  n1 -> n2 -> n4 -> n5      n1 -> n3      n9 disconnected
 * depths:   n1=0, n2=1, n3=1, n4=2, n5=3, n9 unreachable
 */
function fixture() {
  const store = new ContextGraphStore();
  store.writeNode('n1', 'root node content here', ['root'], loc(0));
  store.writeNode('n2', 'second node content here', ['a'], loc(1));
  store.writeNode('n3', 'third node content here', ['b'], loc(1));
  store.writeNode('n4', 'fourth node content here', [], loc(2));
  store.writeNode('n5', 'fifth node content here', [], loc(3));
  store.writeNode('n9', 'orphan node content here', ['orphan'], loc(0));
  store.writeEdge('n1', 'n2', 'next', loc(1));
  store.writeEdge('n1', 'n3', 'next', loc(1));
  store.writeEdge('n2', 'n4', 'next', loc(2));
  store.writeEdge('n4', 'n5', 'next', loc(3));
  return store;
}

const ids = entries => entries.map(e => e.node.id);

// Fixture-tuned: cuts the buffer mid-way (n4/n5 dimmed), see src/extract.js.
const BUDGET_CUT_TOKENS = 60;

const EXTRACT_CASES = [
  {
    name: 'unbounded: whole reachable component is lit',
    budget: {},
    lit: ['n1', 'n2', 'n3', 'n4', 'n5'],
    frontier: []
  },
  {
    name: 'depth cutoff 0: only root lit, neighbours dimmed',
    budget: { maxDepth: 0 },
    lit: ['n1'],
    frontier: ['n2', 'n3']
  },
  {
    name: 'depth cutoff 1: beyond-depth nodes are frontier, not expanded',
    budget: { maxDepth: 1 },
    lit: ['n1', 'n2', 'n3'],
    frontier: ['n4'] // n5 is behind n4: still fog, never surfaces
  },
  {
    name: 'depth cutoff 2: n5 becomes the frontier',
    budget: { maxDepth: 2 },
    lit: ['n1', 'n2', 'n3', 'n4'],
    frontier: ['n5']
  }
];

function testExtractTable() {
  const store = fixture();
  for (const c of EXTRACT_CASES) {
    const out = extract(store, 'n1', c.budget);
    assert(
      JSON.stringify(ids(out.lit)) === JSON.stringify(c.lit),
      `${c.name}: lit ${JSON.stringify(ids(out.lit))} === ${JSON.stringify(c.lit)}`
    );
    assert(
      JSON.stringify(ids(out.frontier)) === JSON.stringify(c.frontier),
      `${c.name}: frontier ${JSON.stringify(ids(out.frontier))} === ${JSON.stringify(c.frontier)}`
    );
    assert(!out.text.includes('n9'), `${c.name}: disconnected node stays fog`);
    assert(out.text.includes('## fog (frontier)'), `${c.name}: frontier summary always rendered`);
  }
}

function testExtractBudgetCut() {
  const store = fixture();
  const full = extract(store, 'n1', {});
  assert(full.truncated === false, 'unbounded extraction is not truncated');

  const cut = extract(store, 'n1', { maxTokens: BUDGET_CUT_TOKENS });
  assert(cut.tokens <= BUDGET_CUT_TOKENS, `budget respected: ${cut.tokens} <= ${BUDGET_CUT_TOKENS}`);
  assert(cut.lit.length > 0, 'budget cut keeps at least the root lit');
  assert(cut.lit.length < full.lit.length, 'budget cut drops the farthest nodes');
  assert(cut.truncated === true, 'budget cut reports truncated');
  assert(ids(cut.lit)[0] === 'n1', 'budget cut keeps nearest-first order');
  // Dropped nodes are dimmed, not deleted.
  assert(cut.lit.length + cut.frontier.length === full.lit.length, 'dropped lit nodes become frontier');

  // Floor: a budget too small even for the header + frontier summary degrades
  // to an all-fog buffer instead of throwing.
  const floor = extract(store, 'n1', { maxTokens: 1 });
  assert(floor.lit.length === 0, 'sub-minimal budget lights nothing');
  assert(floor.frontier.length === full.lit.length, 'sub-minimal budget dims everything');
  assert(floor.truncated === true, 'sub-minimal budget reports truncated');
}

function testExtractDeterministic() {
  const a = extract(fixture(), 'n1', { maxTokens: 60 });
  const b = extract(fixture(), 'n1', { maxTokens: 60 });
  assert(a.text === b.text, 'same (graph, root, budget) renders identical buffer');
}

function testExtractLocationMarkers() {
  const out = extract(fixture(), 'n1', { maxDepth: 1 });
  assert(out.text.includes('[d0 c=main] n1:'), 'lit lines carry depth + cluster markers');
  assert(out.text.includes('[d1 c=main] n2:'), 'depth marker tracks BFS distance');
  assert(out.text.includes('- n4 (d2, c=main)'), 'frontier lines carry location, no content');
  assert(!out.text.includes('fourth node content'), 'frontier hides content');
}

function testExtractValidation() {
  const store = fixture();
  try {
    extract(store, 'nope', {});
    assert(false, 'Should reject unknown root');
  } catch (e) {
    assert(e.message.includes('Unknown root'), 'Rejects unknown root');
  }
  try {
    extract(store, 'n1', { maxTokens: 0 });
    assert(false, 'Should reject non-positive maxTokens');
  } catch (e) {
    assert(e.message.includes('maxTokens'), 'Rejects non-positive maxTokens');
  }
  try {
    extract(store, 'n1', { maxDepth: -1 });
    assert(false, 'Should reject negative maxDepth');
  } catch (e) {
    assert(e.message.includes('maxDepth'), 'Rejects negative maxDepth');
  }
  // Disconnected node is a valid root of its own component.
  const orphan = extract(store, 'n9', {});
  assert(ids(orphan.lit).length === 1 && orphan.lit[0].node.id === 'n9', 'orphan root extracts alone');
  assert(orphan.frontier.length === 0, 'orphan root has empty frontier');
}

// Run tests
console.log('Running tests...');
testNodeWrite();
console.log('✓ testNodeWrite');

testEdgeWrite();
console.log('✓ testEdgeWrite');

testLocationTracking();
console.log('✓ testLocationTracking');

testIdempotentRewrite();
console.log('✓ testIdempotentRewrite');

testValidation();
console.log('✓ testValidation');

testExtractTable();
console.log('✓ testExtractTable');

testExtractBudgetCut();
console.log('✓ testExtractBudgetCut');

testExtractDeterministic();
console.log('✓ testExtractDeterministic');

testExtractLocationMarkers();
console.log('✓ testExtractLocationMarkers');

testExtractValidation();
console.log('✓ testExtractValidation');

console.log('\nAll tests passed.');
