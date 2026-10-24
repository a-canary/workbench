# CONTEXT.md — context-graph vocabulary

The context-graph is a persistent, location-tagged graph that an agent loop
reads and writes through a bounded buffer. The core idea: the graph is the
memory, the buffer is the viewport, and "location" is how a small viewport
stays relevant to a huge graph.

## Terms

- **Graph** — the persistent store. Nodes and edges, each carrying location
  metadata. Survives sessions. (slice 1: `ContextGraphStore`)
- **Buffer** — the bounded working context. A batch of events in, a rendered
  map out. Never holds the whole graph.
- **Location** — where a node/edge sits in the graph: `depth` (distance from
  the current root), `parent_chain` (path from root), `cluster_id` (the buffer
  batch that minted it), plus free-form tags. Location is what makes a node
  findable without scanning.
- **Root** — the node the current loop iteration is "standing on" (usually the
  latest conversation/event node). All extraction is relative to a root.
- **Fog-of-war extraction** — graph + root + budget → bounded sub-map. BFS
  from the root, expanding nearest nodes first, stopping at the token/edge
  budget. What fits is "lit"; the rest stays fog. The rendered buffer shows
  the lit region plus a frontier summary (counts/labels of adjacent fog) so
  the LLM knows what it is *not* seeing.
- **Ingestion** — buffer → graph. Distill buffer events into node/edge writes
  with location tags. Idempotent per event id.
- **Loop** — the operating pattern:
  `buffer → ingest → locate → extract (fog-of-war) → render buffer → LLM → toolcall → [loop]`
  Each toolcall result lands in the buffer, gets ingested, moves the root.
- **Budget** — the extraction constraint: max nodes, max edges, or max tokens
  for the rendered buffer. The single knob that trades context size for
  coverage.
- **Frontier summary** — the compressed description of the fog boundary: what
  clusters/labels sit just outside the lit region. Cheap to render, keeps the
  LLM from acting as if the lit region were the whole graph.
- **Baseline (flat-truncation)** — the control arm: same events, same budget,
  no graph — just the most recent N tokens. The A/B gate (slice 5) compares
  graph-buffer vs this baseline on harness-bench metrics.

## Invariants

- The buffer is always bounded; the graph is always append-mostly.
- Every node/edge carries location metadata at write time (never backfilled).
- Extraction is deterministic for (graph, root, budget) — same input, same map.
- The rendered buffer always includes its frontier summary.

## Non-goals (for now)

- No vector/semantic search — location is structural (BFS), not embedding-based.
  Revisit only if the A/B gate shows structural locality is the bottleneck.
- No multi-agent shared graph. One loop, one graph.
- No vast spend. LLM calls go through the slow lane or local models.
