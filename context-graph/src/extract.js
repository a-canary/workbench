/**
 * Fog-of-war extractor: graph + root + budget -> bounded context buffer.
 *
 * BFS from the root over undirected adjacency (context relevance is not
 * directional). Nodes that fit the budget are "lit" (full content); reachable
 * nodes that do not — because of the depth cutoff or the token budget — are
 * the "frontier" (id/depth/tags only, no content). Unreachable nodes stay fog:
 * absent from the buffer entirely.
 *
 * Deterministic for (graph, root, budget): BFS order is queue order, and
 * neighbours are read in edge-insertion order.
 */

// ponytail: chars/4 token estimate. Swap for a real tokenizer only if the A/B
// gate shows budget accuracy is the bottleneck.
const countTokens = text => Math.ceil(text.length / 4);

// ponytail: frontier summary capped at 5 entries + a "+N more" line, so the
// summary can never blow the budget it is supposed to describe.
const FRONTIER_LIMIT = 5;

/**
 * @typedef {Object} Budget
 * @property {number} [maxTokens] token ceiling for the whole rendered buffer
 * @property {number} [maxDepth] BFS depth cutoff (root = 0)
 */

/**
 * @param {import('./store.js').ContextGraphStore} store
 * @param {string} rootId
 * @param {Budget} [budget]
 * @returns {{ lit: Array, frontier: Array, text: string, tokens: number, truncated: boolean }}
 */
export function extract(store, rootId, budget = {}) {
  const { maxTokens = Infinity, maxDepth = Infinity } = budget;
  if (typeof maxTokens !== 'number' || maxTokens <= 0) {
    throw new Error('Budget.maxTokens must be positive number');
  }
  if (typeof maxDepth !== 'number' || maxDepth < 0) {
    throw new Error('Budget.maxDepth must be non-negative number');
  }
  const root = store.readNode(rootId);
  if (!root) {
    throw new Error(`Unknown root node '${rootId}'`);
  }

  const { reached, beyond } = bfs(store, rootId, maxDepth);

  // Greedy prefix: BFS order puts nearest first, so cutting from the tail
  // drops the least relevant nodes. Shrink until the whole render fits.
  let cut = reached.length;
  let view = render(rootId, budget, reached, beyond, cut);
  while (cut > 0 && countTokens(view.text) > maxTokens) {
    cut -= 1;
    view = render(rootId, budget, reached, beyond, cut);
  }

  return {
    lit: view.lit,
    frontier: view.frontier,
    text: view.text,
    tokens: countTokens(view.text),
    truncated: cut < reached.length || beyond.length > 0
  };
}

/**
 * BFS from root. Nodes past maxDepth are recorded but never expanded — a
 * dimmed node's own neighbours are still fog.
 * @private
 */
function bfs(store, rootId, maxDepth) {
  const seen = new Set([rootId]);
  const reached = [{ node: store.readNode(rootId), depth: 0 }];
  const beyond = [];
  const queue = [[rootId, 0]];

  while (queue.length) {
    const [id, depth] = queue.shift();
    const neighbours = [
      ...store.readEdgesFrom(id).map(e => e.dst),
      ...store.readEdgesTo(id).map(e => e.src)
    ];
    for (const nid of neighbours) {
      if (seen.has(nid)) continue;
      const node = store.readNode(nid);
      if (!node) continue; // dangling edge target
      seen.add(nid);
      if (depth + 1 > maxDepth) {
        beyond.push({ node, depth: depth + 1 });
        continue;
      }
      reached.push({ node, depth: depth + 1 });
      queue.push([nid, depth + 1]);
    }
  }
  return { reached, beyond };
}

/**
 * Render the buffer for a given lit-prefix length.
 * @private
 */
function render(rootId, budget, reached, beyond, cut) {
  const lit = reached.slice(0, cut);
  const frontier = [...reached.slice(cut), ...beyond].sort((a, b) => a.depth - b.depth);

  const lines = [`# context buffer @root=${rootId} ${describeBudget(budget)}`, '## lit'];
  for (const { node, depth } of lit) {
    lines.push(`[d${depth} c=${node.location.cluster_id}] ${node.id}: ${node.content}`);
  }
  lines.push('## fog (frontier)');
  for (const { node, depth } of frontier.slice(0, FRONTIER_LIMIT)) {
    const tags = node.tags.length ? ` [${node.tags.join(',')}]` : '';
    lines.push(`- ${node.id} (d${depth}, c=${node.location.cluster_id})${tags}`);
  }
  if (frontier.length > FRONTIER_LIMIT) {
    lines.push(`- ... +${frontier.length - FRONTIER_LIMIT} more`);
  }

  return { lit, frontier, text: lines.join('\n') };
}

/** @private */
function describeBudget({ maxTokens = Infinity, maxDepth = Infinity }) {
  const parts = [];
  if (maxTokens !== Infinity) parts.push(`maxTokens=${maxTokens}`);
  if (maxDepth !== Infinity) parts.push(`maxDepth=${maxDepth}`);
  return parts.length ? parts.join(' ') : 'budget=unbounded';
}
