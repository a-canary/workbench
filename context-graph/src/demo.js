/**
 * Demo: buffer event distillation into location-tagged nodes/edges.
 *
 * Scenario: buffer contains tool events (e.g. "called tool X with args Y, got result Z").
 * These are distilled into graph nodes/edges, each tagged with its location in the buffer
 * (parent conversation/session id, depth in the buffer timeline, cluster for batching).
 */

import { ContextGraphStore } from './store.js';
import { extract } from './extract.js';

const store = new ContextGraphStore();

// Simulated buffer events from a conversation.
const bufferEvents = [
  {
    seq: 1,
    kind: 'tool_call',
    tool: 'read_file',
    args: { path: '/home/user/data.txt' }
  },
  {
    seq: 2,
    kind: 'tool_result',
    result: 'file content here'
  },
  {
    seq: 3,
    kind: 'tool_call',
    tool: 'grep',
    args: { pattern: 'error', file: '/home/user/data.txt' }
  }
];

// Location context: these events belong to conversation "conv-001", batch 0 (initial write).
const sessionLocation = {
  parent_chain: ['conv-001'],
  depth: 0,
  cluster_id: 'buffer-batch-0'
};

// Distill buffer events into nodes/edges.
console.log('Distilling buffer events into graph...\n');

// Create a node for the session.
const sessionNode = store.writeNode(
  'conv-001',
  'Conversation session',
  ['session', 'root'],
  sessionLocation
);
console.log(`✓ Created session node: ${sessionNode.id}`);

// Create nodes for each event, with location tracking depth.
const eventNodes = [];
bufferEvents.forEach((event, idx) => {
  const eventLocation = {
    parent_chain: ['conv-001', `buffer-${idx}`],
    depth: idx + 1,
    cluster_id: 'buffer-batch-0'
  };

  const nodeId = `event-${event.seq}`;
  const node = store.writeNode(
    nodeId,
    JSON.stringify({
      kind: event.kind,
      tool: event.tool,
      seq: event.seq
    }),
    [event.kind, event.tool || 'none'],
    eventLocation
  );

  eventNodes.push(node);
  console.log(`✓ Created event node: ${nodeId} at depth ${eventLocation.depth}`);
});

// Create edges: session -> events, tool_call -> tool_result.
console.log('\nCreating edges...\n');

const edgeLocation = {
  parent_chain: ['conv-001'],
  depth: 0,
  cluster_id: 'buffer-batch-0'
};

eventNodes.forEach((node, idx) => {
  const edge = store.writeEdge('conv-001', node.id, 'contains', edgeLocation);
  console.log(`✓ Edge: conv-001 --[contains]--> ${node.id}`);
});

// Edge between tool call and tool result.
const callResultEdge = store.writeEdge(
  'event-1',
  'event-2',
  'produces',
  edgeLocation
);
console.log(`✓ Edge: event-1 --[produces]--> event-2`);

// Summary.
console.log(`\n--- Store Summary ---`);
console.log(`Nodes: ${store.nodeCount()}`);
console.log(`Edges: ${store.edgeCount()}`);
console.log(`\nNodes with location tracking:`);
store.nodes.forEach((node) => {
  console.log(
    `  ${node.id}: depth=${node.location.depth}, ` +
    `cluster=${node.location.cluster_id}, tags=[${node.tags.join(', ')}]`
  );
});

console.log(`\nEdges with location tracking:`);
store.edges.forEach((edge) => {
  console.log(
    `  ${edge.src} --[${edge.label}]--> ${edge.dst} ` +
    `(cluster: ${edge.location.cluster_id})`
  );
});

console.log(`\n✓ Demo complete. Buffer events distilled into location-tagged nodes/edges.`);

// --- fog-of-war extraction ------------------------------------------------

const root = [...store.nodes.keys()][0];
for (const budget of [{}, { maxDepth: 1 }, { maxTokens: 75 }]) {
  const view = extract(store, root, budget);
  console.log(`\n--- extract ${JSON.stringify(budget)} -> ${view.tokens} tokens ---`);
  console.log(view.text);
}
