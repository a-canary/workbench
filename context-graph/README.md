# context-graph

Persistent context-graph substrate for agent loops.

- buffer -> graph: context buffer events distilled into location-tagged nodes/edges.
- graph+location -> buffer: BFS / fog-of-war extraction of a bounded relevant map.
- loop: buffer -> graph traversal -> buffer -> LLM -> toolcall -> [loop].

Hillclimb signal: harness-bench metrics (quality, pass rate + Wilson CI, tokens, duration).
A/B: graph-buffer vs flat-truncation baseline. Pre-registered gate before measuring.

Constraints: no vast spend; LLM via cli-proxy slow lane or local models; TS, node>=23, zero deps.
Ledger project: `context-graph` (PRD `context-graph-harness-persistent-context`).
