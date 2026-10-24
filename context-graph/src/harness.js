/**
 * Context-graph harness for harness-bench.
 *
 * Real agent loop: task + fog-of-war graph buffer → Bonsai-27B → JSON tool
 * call → execute → ingest result into graph → repeat. Tokens are real API
 * usage, not estimates.
 *
 * A/B partner: the bare `pi` harness (flat context, everything accumulates).
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { ContextGraphStore } from './store.js';
import { extract } from './extract.js';
import { chat, llmModelId } from './llm.js';

// ============================================================================
// Tools — same capability class as the pi baseline (fs + bash)
// ============================================================================

const tools = {
  read_file: (args) => {
    try {
      return { success: true, content: fs.readFileSync(args.path, 'utf8').slice(0, 20000) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  write_file: (args) => {
    try {
      fs.mkdirSync(path.dirname(args.path), { recursive: true });
      fs.writeFileSync(args.path, args.content ?? '', 'utf8');
      return { success: true, path: args.path };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  list_dir: (args) => {
    try {
      return { success: true, files: fs.readdirSync(args.path || '.') };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  grep: (args) => {
    try {
      const lines = fs.readFileSync(args.path, 'utf8').split('\n');
      const matches = lines
        .map((line, idx) => ({ line, idx: idx + 1 }))
        .filter(({ line }) => line.includes(args.pattern))
        .slice(0, 10);
      return { success: true, matches };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  bash: (args) => {
    try {
      const out = execSync(args.command, {
        cwd: process.cwd(),
        timeout: 60000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { success: true, output: (out || '').slice(0, 8000) };
    } catch (err) {
      return { success: false, error: String(err.message || err).slice(0, 2000) };
    }
  },
};

const TOOL_SCHEMA = `Tools:
- read_file {"path": "..."} — read a file
- write_file {"path": "...", "content": "..."} — create/overwrite a file
- list_dir {"path": "."} — list directory
- grep {"pattern": "...", "path": "..."} — substring search in a file
- bash {"command": "..."} — run a shell command in the workdir`;

const SYSTEM_PROMPT = `You are an agent completing a task in a working directory.
Each turn respond with EXACTLY one JSON object and nothing else:
{"tool": "<name>", "args": {...}} to call a tool, or {"done": true} when the task is complete.
${TOOL_SCHEMA}`;

// ============================================================================
// LLM decision (v2): stateful incremental prompt
//
// v1 re-derived task state from the buffer on every call, so the model burned
// 500-900 reasoning output tokens per iteration re-reading its own history.
// v2 keeps the last RECENT_TURNS actions/results as real conversation turns —
// the model reads its own prior decision instead of re-deriving it — and lets
// the fog-of-war graph buffer stand in for everything older (dimmed context).
// ============================================================================

// ponytail: N=6 turns verbatim (~12 messages) keeps the prompt bounded on a
// 1-bit 27B while covering the working set; older turns survive in the graph
// buffer. Raise only if the trace shows recall misses, not on principle.
const RECENT_TURNS = 6;

/**
 * Build the message array for one decision.
 * @param {string} instruction task text
 * @param {string} bufferText fog-of-war render of the graph (older turns)
 * @param {Array<{action: string, result: string}>} turns full turn history
 */
export function buildMessages(instruction, bufferText, turns) {
  const recent = turns.slice(-RECENT_TURNS);
  const olderCount = turns.length - recent.length;

  const opening = [`Task: ${instruction}`];
  if (olderCount > 0) {
    opening.push(
      '',
      `Earlier context (${olderCount} older turn(s), compacted from the session graph — fog-of-war view):`,
      bufferText || '(empty)'
    );
  }
  opening.push('', 'Work the task one action at a time. Reply with one JSON object.');

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: opening.join('\n') },
  ];

  for (const turn of recent) {
    messages.push({ role: 'assistant', content: turn.action });
    messages.push({ role: 'user', content: `Tool result: ${turn.result}\n\nNext action (one JSON object):` });
  }

  if (!recent.length) {
    messages[messages.length - 1].content += '\n\nNext action (one JSON object):';
  }

  return messages;
}

async function decide(instruction, bufferText, turns) {
  const messages = buildMessages(instruction, bufferText, turns);
  const { content, usage } = await chat(messages);
  return { action: parseAction(content), usage, raw: content, messageCount: messages.length };
}

/** Lenient JSON extraction: strip fences, first balanced object. */
function parseAction(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = t.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    if (t[i] === '{') depth++;
    else if (t[i] === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(t.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ============================================================================
// Ingest: events → graph nodes/edges (unchanged from toy)
// ============================================================================

function ingestEvents(store, sessionId, bufferEvents, clusterBatchId) {
  const location = {
    parent_chain: [sessionId],
    depth: 0,
    cluster_id: clusterBatchId,
  };

  for (const event of bufferEvents) {
    const nodeId = `${event.kind}-${event.seq}`;
    const tags = [event.kind, event.tool || event.status || 'none'];
    const content = JSON.stringify({
      kind: event.kind,
      tool: event.tool,
      status: event.status,
      seq: event.seq,
      result: event.result || undefined,
    });

    store.writeNode(nodeId, content, tags, { ...location, depth: event.seq });
    store.writeEdge(sessionId, nodeId, 'event', location);
  }
}

// ============================================================================
// Main loop
// ============================================================================

const MAX_ITERATIONS = 15;

// ============================================================================
// v3: fill-to-quality-window buffer budget
//
// v2 capped the graph buffer at a fixed 2000 tokens. v3 sizes the buffer to
// fill the model's high-quality (pre-rot) window: the fog-of-war extractor
// ranks nodes by relevance and fills up to (fillFrac x qualityWindow) minus
// what the verbatim part of the prompt already occupies. Short tasks keep a
// small buffer (little in the graph); long tasks fill the ideal zone.
//
// qualityWindow is a CALIBRATION KNOB per model, not a constant: Bonsai-27B's
// raw window is 131k but it is a 1-bit quant on an 8GB 4060 — prefilling
// 98k/call is physically wrong (KV memory + prefill time). 16384 is the
// initial value (12.3k fill at 0.75). Changing it is a new run, not a re-tune.
// ============================================================================

export const DEFAULT_QUALITY_WINDOW = 16384;
export const DEFAULT_FILL_FRAC = 0.75;
export const DEFAULT_MAX_DEPTH = 5;

/** Rough budget-side token estimate (chars/4). Real usage is traced per call. */
export function estTokens(text) {
  return Math.ceil(String(text ?? '').length / 4);
}

/**
 * Buffer budget for one iteration.
 * budget = max(0, fillFrac x qualityWindow - (system + task + recent turns))
 * The recent turns are the verbatim conversation (last RECENT_TURNS); the
 * buffer stands in for everything older, so only the verbatim part is
 * reserved against the fill target.
 */
export function computeBudget(instruction, turns, qualityWindow = DEFAULT_QUALITY_WINDOW, fillFrac = DEFAULT_FILL_FRAC) {
  const fillTarget = fillFrac * qualityWindow;
  const recent = turns.slice(-RECENT_TURNS);
  const recentTokens = recent.reduce((sum, t) => sum + estTokens(t.action) + estTokens(t.result), 0);
  const reservation = estTokens(SYSTEM_PROMPT) + estTokens(instruction) + recentTokens;
  return Math.max(0, Math.floor(fillTarget - reservation));
}

export async function runHarnessLoop(model, instruction, qualityWindow = DEFAULT_QUALITY_WINDOW, fillFrac = DEFAULT_FILL_FRAC) {
  const startTime = Date.now();
  const store = new ContextGraphStore();
  const sessionId = 'session-' + Math.random().toString(36).slice(2, 8);
  const totals = { input: 0, output: 0, total: 0 };
  let iteration = 0;
  const turns = [];
  let done = false;
  let parseFails = 0;

  const sessionLoc = { parent_chain: [], depth: 0, cluster_id: 'init' };
  store.writeNode(sessionId, `Task: ${instruction}`, ['session', 'root'], sessionLoc);

  emitNDJSON({ type: 'harness_start', model, instruction, timestamp: new Date().toISOString() });

  while (!done && iteration < MAX_ITERATIONS) {
    const budget = computeBudget(instruction, turns, qualityWindow, fillFrac);
    const view = extract(store, sessionId, { maxTokens: budget, maxDepth: DEFAULT_MAX_DEPTH });

    let decision;
    try {
      decision = await decide(instruction, view.text, turns);
    } catch (err) {
      emitNDJSON({ type: 'harness_error', error: `llm: ${err.message}`, iteration });
      break;
    }
    totals.input += decision.usage.input;
    totals.output += decision.usage.output;
    totals.total += decision.usage.total;

    emitNDJSON({
      type: 'harness_call',
      iteration,
      messages: decision.messageCount,
      recentTurns: Math.min(turns.length, RECENT_TURNS),
      olderTurns: Math.max(0, turns.length - RECENT_TURNS),
      promptTokens: decision.usage.input,
      outputTokens: decision.usage.output,
      bufferTokens: view.tokens,
      bufferBudget: budget,
      qualityWindow,
      fillFrac,
    });

    const action = decision.action;
    if (!action) {
      parseFails++;
      turns.push({
        action: (decision.raw || '').slice(0, 500),
        result: '(that was not valid JSON — reply with exactly one JSON object and nothing else)',
      });
      iteration++;
      continue;
    }

    if (action.done) {
      done = true;
      break;
    }

    const toolName = action.tool;
    const toolFn = tools[toolName];
    const seq = iteration * 100;

    if (!toolFn) {
      turns.push({
        action: JSON.stringify(action),
        result: `unknown tool "${toolName}" — use one of: ${Object.keys(tools).join(', ')}`,
      });
      iteration++;
      continue;
    }

    ingestEvents(store, sessionId, [{ seq, kind: 'tool_call', tool: toolName, args: action.args }], `iter-${iteration}`);

    const result = toolFn(action.args || {});
    const resultJson = JSON.stringify(result).slice(0, 2000);
    ingestEvents(store, sessionId, [{ seq: seq + 1, kind: 'tool_result', tool: toolName, status: result.success ? 'ok' : 'error', result: resultJson }], `iter-${iteration}`);

    turns.push({ action: JSON.stringify(action), result: resultJson });
    iteration++;
  }

  const duration = Date.now() - startTime;

  // Real token usage from the LLM API, in the shape harness-bench parses.
  emitNDJSON({
    type: 'agent_end',
    timestamp: new Date().toISOString(),
    model: llmModelId,
    messages: [
      {
        role: 'assistant',
        model: llmModelId,
        usage: {
          input: totals.input,
          output: totals.output,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: totals.total,
        },
      },
    ],
  });

  emitNDJSON({
    type: 'harness_end',
    sessionId,
    iterations: iteration,
    parseFails,
    done,
    duration,
    nodes: store.nodeCount(),
    edges: store.edgeCount(),
    timestamp: new Date().toISOString(),
  });
}

function emitNDJSON(obj) {
  console.log(JSON.stringify(obj));
}
