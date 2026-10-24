/**
 * Context-graph loop: buffer -> extract -> LLM -> toolcall -> ingest -> [loop]
 *
 * Toy canary: 3-5 tool tasks, end-to-end run, transcript logged.
 * - Uses mock LLM (no cli-proxy dependency).
 * - Runs filesystem tools (read_file, list_dir, write_file).
 * - Tracks graph + location in each prompt iteration.
 */

import fs from 'fs';
import path from 'path';
import { ContextGraphStore } from './store.js';
import { extract } from './extract.js';

// ============================================================================
// Tool implementations
// ============================================================================

const tools = {
  read_file: (args) => {
    const filePath = args.path;
    try {
      return { success: true, content: fs.readFileSync(filePath, 'utf8') };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  list_dir: (args) => {
    const dirPath = args.path || '.';
    try {
      const files = fs.readdirSync(dirPath);
      return { success: true, files };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  write_file: (args) => {
    const { path: filePath, content } = args;
    try {
      fs.writeFileSync(filePath, content, 'utf8');
      return { success: true, path: filePath };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  count_lines: (args) => {
    const filePath = args.path;
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n').length;
      return { success: true, lines };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  grep: (args) => {
    const { pattern, path: filePath } = args;
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      const matches = lines
        .map((line, idx) => ({ line, idx: idx + 1 }))
        .filter(({ line }) => line.includes(pattern));
      return { success: true, matches: matches.slice(0, 5) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
};

// ============================================================================
// Mock LLM: generates tool calls based on buffer content and iteration
// ============================================================================

function mockLLM(buffer, iteration) {
  // ponytail: mock LLM that generates tool calls based on iteration.
  // Real LLM would parse the buffer and generate smart tasks.
  const toolSequence = [
    {
      tool: 'list_dir',
      args: { path: process.cwd() }
    },
    {
      tool: 'read_file',
      args: { path: 'package.json' }
    },
    {
      tool: 'count_lines',
      args: { path: 'src/loop.js' }
    },
    {
      tool: 'grep',
      args: { pattern: 'tool', path: 'src/loop.js' }
    },
    null // end of sequence
  ];

  const toolCall = toolSequence[iteration];
  if (!toolCall) {
    return {
      reasoning: 'Completed all tool tasks.',
      tool_calls: []
    };
  }

  return {
    reasoning: `Iteration ${iteration}: executing ${toolCall.tool}`,
    tool_calls: [toolCall]
  };
}

// ============================================================================
// Ingest: buffer events -> graph nodes/edges
// ============================================================================

function ingestEvents(store, sessionId, bufferEvents, clusterBatchId) {
  const location = {
    parent_chain: [sessionId],
    depth: 0,
    cluster_id: clusterBatchId
  };

  for (const event of bufferEvents) {
    const nodeId = `${event.kind}-${event.seq}`;
    const tags = [event.kind, event.tool || event.status || 'none'];
    const content = JSON.stringify({
      kind: event.kind,
      tool: event.tool,
      status: event.status,
      seq: event.seq,
      result: event.result ? '(result)' : undefined
    });

    const eventLoc = {
      ...location,
      depth: event.seq
    };

    store.writeNode(nodeId, content, tags, eventLoc);

    // Create edge from session to event
    store.writeEdge(sessionId, nodeId, 'event', location);
  }
}

// ============================================================================
// Main loop
// ============================================================================

export async function runLoop() {
  const store = new ContextGraphStore();
  const sessionId = 'session-canary-' + Math.random().toString(36).slice(2, 8);
  const transcript = [];
  let iteration = 0;
  let allDone = false;

  // Initialize session node
  const sessionLoc = {
    parent_chain: [],
    depth: 0,
    cluster_id: 'init'
  };
  store.writeNode(sessionId, 'Canary loop session', ['session', 'root'], sessionLoc);
  transcript.push(`## Session: ${sessionId}\n`);

  while (!allDone && iteration < 10) {
    transcript.push(`\n### Iteration ${iteration}`);

    // Extract buffer from graph
    const view = extract(store, sessionId, { maxTokens: 500, maxDepth: 5 });
    transcript.push(`\nExtracted buffer (${view.tokens} tokens):\n\`\`\`\n${view.text}\n\`\`\``);

    // Call (mock) LLM
    const llmResponse = mockLLM(view.text, iteration);
    transcript.push(`\nLLM reasoning: ${llmResponse.reasoning}`);

    if (llmResponse.tool_calls.length === 0) {
      transcript.push('\nNo more tool calls. Loop complete.');
      allDone = true;
      break;
    }

    // Execute tool calls and ingest results
    const newEvents = [];
    for (const toolCall of llmResponse.tool_calls) {
      const toolSeq = Math.floor(iteration * 100 + newEvents.length);
      const callEvent = {
        seq: toolSeq,
        kind: 'tool_call',
        tool: toolCall.tool,
        args: toolCall.args
      };
      newEvents.push(callEvent);
      transcript.push(`\nTool call: ${toolCall.tool}(${JSON.stringify(toolCall.args)})`);

      // Execute tool
      const toolFn = tools[toolCall.tool];
      if (!toolFn) {
        transcript.push(`  ERROR: unknown tool`);
        continue;
      }

      const result = toolFn(toolCall.args);
      const resultEvent = {
        seq: toolSeq + 1,
        kind: 'tool_result',
        tool: toolCall.tool,
        status: result.success ? 'ok' : 'error',
        result: JSON.stringify(result).slice(0, 200) // truncate for brevity
      };
      newEvents.push(resultEvent);
      transcript.push(`  Result: ${result.success ? 'ok' : 'error'} (${result.error || 'no error'})`);

      // Ingest into graph
      const clusterBatchId = `buffer-batch-${iteration}`;
      ingestEvents(store, sessionId, [callEvent, resultEvent], clusterBatchId);
    }

    iteration++;
  }

  transcript.push(`\n## Summary`);
  transcript.push(`Iterations: ${iteration}`);
  transcript.push(`Graph nodes: ${store.nodeCount()}`);
  transcript.push(`Graph edges: ${store.edgeCount()}`);
  transcript.push(`Transcript length: ${transcript.join('\n').length} chars`);

  return {
    sessionId,
    iterations: iteration,
    nodeCount: store.nodeCount(),
    edgeCount: store.edgeCount(),
    transcript: transcript.join('\n'),
    success: allDone
  };
}

// ============================================================================
// CLI entry point
// ============================================================================

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runLoop();
  console.log(result.transcript);
  console.log(`\n✓ Loop complete. ${result.nodeCount} nodes, ${result.edgeCount} edges.`);
  process.exit(result.success ? 0 : 1);
}

export { tools, mockLLM };
