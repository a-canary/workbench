# arc-llm-proxy ontology — OVERVIEW

scope: server.ts, auto-llm.ts, sse-fix.ts, e2e.mjs, queue.test.ts, sse-fix.test.ts, auto-llm.test.ts
surveyed_at_sha: 02dce8a

LLM gateway ("switchboard") on :8091 — endpoint pool, alias routing, auth, audit — with `auto-llm`, a cost- and cache-aware Thompson-sampling adaptive model router mounted at the `auto-llm` alias. Zoom: vocabulary + request lifecycle live in [router.md](router.md).

## Components (4 source files)

- `server.ts` — the switchboard: endpoint pool + health probes, alias routing, queue/dispatch, `authUser`, per-class `rewriteBody` token caps, audit; mounts autoLlm at alias `auto-llm` inside a try/catch fallthrough (:29 import, :845–852 mount). Owns the HOME cache-affinity table (:284–286, uncapped `Map<convKey,ep>`).
- `auto-llm.ts` (~870 ln) — the adaptive router: judge classification, beta priors, cost+cache-aware arm selection, upstream fan-out with cooldown, P1 degeneracy gate, B attacker triage, P2 hold-back delivery, reward + pricing. Singleton `autoLlm` (:869), `hasCfg` (:870).
- `sse-fix.ts` — SSE stream repair (upstream framing glitches → clean client events). Covered by `sse-fix.test.ts`.
- `e2e.mjs` — end-to-end smoke run against a live listener.

Tests: `queue.test.ts` (pure switchboard core: parseModel, authUser, rewriteBody, pickNext — no sockets), `sse-fix.test.ts`, `auto-llm.test.ts`. Gate = `node --test queue.test.ts sse-fix.test.ts auto-llm.test.ts` (51 tests). Plain `tsc` is NOT clean (pre-existing strict errors, no @types/node wired) — deliberately not the gate.

## State

- Disk (survives restart): `deploy/ts-state.json` (beta priors; hot-reloaded on mtime), `deploy/market-prices.json` (TTL 24h), `deploy/auto-llm.json` (config), `deploy/keys.json`, `deploy/auto-llm.log`, `deploy/audit.jsonl`.
- Memory only (lost on restart): per-user `errs` cooldowns, `hot` cache-heat table (LRU cap 4096), HOME affinity, in-flight requests.

## Known gaps (worst first)

1. **No outage fallback arm** — if all 5 arms fail (observed ~14:40–14:45: 110–220s/turn exhaustion, self-recovered), turns 5xx; no last-resort arm. v1 deliberately bypasses the switchboard queue/slots — 9router owns retry (auto-llm.ts:28 `ponytail:`).
2. **401 storms are memory-only-cooled** — per-user `errs` cooldowns don't survive restart; a restart re-arms an external-key storm.
3. **Restart wipes heat + HOME** — cache-aware pricing and stickiness collapse to cold; priors survive, so the ladder re-explores cheaply.
4. **Import cycle** auto-llm.ts ↔ server.ts (`affinityKeyFromBody`) — safe only as an ESM function-declaration live-binding cycle; a const-arrow refactor of that function breaks it.
5. **Deliberate ceilings** (ponytail): switchboard queue bypass (:28); flat price×cacheFactor, no input/output split (:187); JSON unwrap depth cap 4 (:382); heat LRU cap 4096 (:450).

## Map

- docs/ontology/ — this registry (OVERVIEW.md + router.md).
- codemap/ — generated structural snapshot (codemap.puml/.md/.json); diff codemap.json for structural drift.
- docs/ontology/router.md — auto-llm vocabulary, request lifecycle, config surface.