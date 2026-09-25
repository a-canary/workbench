# 05 — Routing Policy

Who uses what, when. Rules in priority order.

## Lane assignment

| Work shape | Route | Why |
|---|---|---|
| Interactive / frontier (interviews, planning, hard debugging) | cli-proxy pools `smart`/`fast` (Max quota, no per-token cost) or anthropic/minimax direct | best intelligence, human waiting |
| Factory workers (ledger-dispatched slices) | arc-proxy aliases via `pi --model arc-proxy/<alias>` (fast lane: `planning`/`hard`/`easy`) | queued, capped, per-project mask |
| Cron / pipelines / subagents / ETL / generation | arc-proxy **slow-lane** aliases (`bench`/`driver`/`hygiene`) | queues behind interactive idle slots; see `/slow-lane` |
| Bulk cheap tokens on hot open models | chutes direct | subscription cap, not agentic |
| Long-tail model variety | openrouter direct | per-model upstream routing |
| Short-prompt latency (judges, classifiers, extract/rewrite) | cerebras direct | ~2200 tok/s; context + TPM caps forbid agentic use |
| Short-context models, any lane | pipeliner (`/pipeliner`) | decompose into chained small modules instead of one long prompt |
| **Last resort — all other endpoints failed** | `veles/qwen3.8-27b` | captain policy 2026-08-24; safe unless the project\|work restricts (per-project carve-out via switchboard `projects.<name>.mask`) |

## Hard rules

1. **Cron jobs never use claude** — they run on free local models via slow-lane aliases; compensate for model limits with pipeliner designs (small chained steps, explicit retries).
2. **Never hit the model box `:1234` directly** — always through arc-llm-proxy so the queue holds.
3. **Never present fabricated data as real (UM-0500)** — applies to routing too: an unprobed endpoint is "unknown", not "up".
4. **Per-project masking** — switchboard `projects.<name>.mask` restricts which aliases a project may use; unknown project → 400 (or `defaultProject` when `strict:false`). Use masks for per-project model carve-outs (e.g. a project banned from the last-resort fallback).
5. **Slow-lane callers set generous timeouts** — requests block in the queue until a slot frees; that waiting is the point.
6. **Thinking-model budget** — local models spend `max_tokens` on reasoning before content; size requests accordingly.

## Failure semantics

- arc-llm-proxy: 429/5xx → breaker (5 min) → next candidate in alias ladder → all unhealthy → 503 (client backs off).
- cli-proxy: pool failover per candidate list; red `smart` smoke = whole pool unusable.
- Public providers: 401 = dead key (rotate in pass), 402 = quota (wait or switch provider), 429 = rate cap (back off).
- **Ghost alias = silent misroute (fixed 2026-08-26)**: unknown exec aliases used to fall back to `default_alias` without error; `getAliasCommands` now throws at dispatch. Treat any *historical* `engine-alias-no-work:<alias>` ledger event whose alias is not in `config.json` as a **config defect**, not a model defect — the named alias never ran.
