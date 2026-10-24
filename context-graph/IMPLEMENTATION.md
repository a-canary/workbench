# Implementation: context-graph store with location-tagged node/edge writes

## What's implemented

**ContextGraphStore** (src/store.js): In-memory graph store with:
- Node API: `writeNode(id, content, tags, location)` — validates and stores nodes
- Edge API: `writeEdge(src, dst, label, location)` — validates and stores edges
- Read APIs: `readNode(id)`, `readEdgesFrom(src)`, `readEdgesTo(dst)`
- Location tracking: every write carries `{ parent_chain: [], depth, cluster_id }`
- Full validation: non-empty IDs, location completeness, depth constraints

**Tests** (src/test.js): Assert-based suite covering:
- Node write and read
- Edge write and read (from/to queries)
- Location persistence across multiple nodes
- Validation rejection of bad inputs

**Demo** (src/demo.js): Realistic scenario:
- Buffer events (tool calls, results) distilled into nodes/edges
- Location tracking shows depth progression and cluster batching
- Output demonstrates graph structure with 4 nodes and 4 edges

## Test results

```
Running tests...
✓ testNodeWrite
✓ testEdgeWrite
✓ testLocationTracking
✓ testValidation

All tests passed.
```

## Demo results

```
Distilling buffer events into graph...
✓ Created session node: conv-001
✓ Created event node: event-1 at depth 1
✓ Created event node: event-2 at depth 2
✓ Created event node: event-3 at depth 3

Creating edges...
✓ Edge: conv-001 --[contains]--> event-1
✓ Edge: conv-001 --[contains]--> event-2
✓ Edge: conv-001 --[contains]--> event-3
✓ Edge: event-1 --[produces]--> event-2

Store Summary:
Nodes: 4
Edges: 4

Nodes with location tracking:
  conv-001: depth=0, cluster=buffer-batch-0, tags=[session, root]
  event-1: depth=1, cluster=buffer-batch-0, tags=[tool_call, read_file]
  event-2: depth=2, cluster=buffer-batch-0, tags=[tool_result, none]
  event-3: depth=3, cluster=buffer-batch-0, tags=[tool_call, grep]

Edges with location tracking:
  conv-001 --[contains]--> event-1 (cluster: buffer-batch-0)
  conv-001 --[contains]--> event-2 (cluster: buffer-batch-0)
  conv-001 --[contains]--> event-3 (cluster: buffer-batch-0)
  event-1 --[produces]--> event-2 (cluster: buffer-batch-0)

✓ Demo complete.
```

## Acceptance criteria met

- [x] Graph store: nodes (id, content, tags) + edges (src, dst, label)
- [x] Location tracking: parent_chain + depth + cluster_id on every write
- [x] Buffer event → distilled node/edge write API (demonstrated in demo)
- [x] Assert-based demo: runs successfully, shows real buffer-to-graph flow
- [x] Test file: covers core functionality and edge cases
- [x] Zero runtime dependencies: uses only Node.js built-ins

## Commit

Commit 1d7571c: "feat: location-tagged graph store with node/edge write API"
- 4 files: package.json, src/store.js, src/demo.js, src/test.js
- 405 insertions
- All tests pass, demo runs successfully

## Blockers

GitHub repo a-canary/context-graph does not exist; pushing to GitHub and opening PR blocked until repo created.

---

# Slice 2 — fog-of-war extractor (`src/extract.js`)

`extract(store, rootId, { maxTokens, maxDepth })` → `{ lit, frontier, text, tokens, truncated }`.

- **BFS** from the root over undirected adjacency (`readEdgesFrom` + `readEdgesTo`);
  context relevance is not directional. Neighbours are visited in edge-insertion
  order, so `(graph, root, budget)` renders byte-identical output every time.
- **Fog-of-war** — three states: *lit* (full content), *frontier* (reachable but
  cut by depth or budget: id/depth/cluster/tags only, no content), *fog*
  (unreachable — absent from the buffer entirely). Nodes past `maxDepth` are
  recorded but never expanded, so a dimmed node's own neighbours stay fog.
- **Budget** — the whole rendered buffer is measured, not just the lit content.
  Lit nodes are a greedy BFS-order prefix, shrunk from the tail until the render
  fits `maxTokens`. Cut nodes fall into the frontier rather than vanishing. A
  budget too small even for header + frontier degrades to an all-fog buffer
  (`lit: []`, `truncated: true`) instead of throwing.
- **Location markers** — lit lines are `[d<depth> c=<cluster>] <id>: <content>`,
  frontier lines are `- <id> (d<depth>, c=<cluster>) [tags]`.

Known ceilings (marked `ponytail:` in source): token count is `chars/4`, and the
frontier summary is capped at 5 entries + a `+N more` line so the summary can
never blow the budget it describes.

## Tests (`src/test.js`, table-driven)

`testExtractTable` covers depth cutoff 0/1/2 and unbounded, asserting exact lit
and frontier id lists, that the disconnected node `n9` never appears, and that
the frontier summary is always rendered. Plus `testExtractBudgetCut` (mid-cut,
budget respected, dropped-lit-becomes-frontier, sub-minimal floor),
`testExtractDeterministic`, `testExtractLocationMarkers` (frontier hides
content), `testExtractValidation` (unknown root, bad budgets, orphan-as-root).

`npm test` → 10/10 pass. `npm run demo` renders the three buffer views.
