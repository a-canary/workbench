# arc-llm-proxy

Switchboard in front of local LLM endpoints. One port, OpenAI-compatible.
Routes by `<project>/<alias>` model names, dispatches a weighted fair queue
(UX class drains before non-UX), fails over across endpoints per alias,
caps tokens per class, and breaks on 429/5xx.

## Model names

`<project>/<alias>` — e.g. `arc-shopper/easy`, `you/hard`.

- **project** picks the dispatch lane: `speed` (weight) + `mask` (ordered
  alias ladder). Unknown project → 400 (or `defaultProject` when `strict` is false).
- **alias** picks the endpoint ladder: ordered failover list. Upstream never
  sees the alias — the proxy rewrites the body to the resolved endpoint's
  `model` name.
- Bare alias (no slash) resolves against `defaultProject`.
- `#slow` / `#fast` suffixes still override the alias's first endpoint
  (compat with the old idle-llm-proxy contract).
- Unknown project / unknown alias / alias outside the project mask → 400
  with a descriptive error naming the known values.
- `/v1/models` lists live 9router models **not on cooldown** (auto-llm universe minus global backoff); the `<project>/<alias>` mask surface only when auto-llm is unconfigured.

## Dispatch

Two queues (UX, non-UX), one dispatch loop. UX drains first (hard floor —
a fresh UX request beats any aged non-UX request). Within a queue:

- `score = wait_ms × project.speed` — a speed-8 project overtakes a speed-1
  project after ~125 ms of waiting; a speed-0 project only wins an empty
  candidate set (never contends).
- Ties → FIFO.
- Dispatch on both edges: request arrival and slot-free. Zero added latency
  when the queue is empty.
- A request is dispatched to the first healthy, free endpoint in
  `project.mask ∩ alias ladder`. 429/5xx trips that endpoint's breaker
  (`breakerMs`, default 5 min) and requeues the request to the next
  candidate. **Unhealthy ≠ busy**: a request whose candidates are all
  unhealthy (breaker or probe-down) gets an immediate 503 — fail fast so
  clients retry with backoff instead of hanging until the breaker expires.
  The sweep runs on every breaker trip, connect-error mark-down, and probe.
- Per-class `max_tokens` cap enforced at body rewrite (UX 16k default) —
  clients cannot exceed it.

## Config

`CONFIG_FILE` (default `switchboard.default.json`):

```json
{
  "endpoints": {
    "local":    { "type": "http", "url": "http://localhost:1234", "model": "Bonsai-27B" },
    "eclaude": { "type": "spawn", "url": "http://127.0.0.1:7890/v1", "model": "claude/opus" }
  },
  "aliases": { "easy": ["local"], "hard": ["eclaude", "local"] },
  "projects": {
    "default":     { "speed": 1, "mask": ["planning", "hard", "easy", "bench", "driver"] },
    "arc-shopper": { "speed": 8, "mask": ["mid", "easy"] }
  },
  "maxTokens": { "ux": 16384, "non-ux": 4096 },
  "defaultProject": "default",
  "strict": false,
  "breakerMs": 300000
}
```

- `endpoints`: `type http` (llama-server, 9router) or `type spawn`
  (cli-proxy / claude — OpenAI-compatible, fresh session per request).
  Health = `/v1/models` probe (UX-class keys may only carry claude
  endpoints in their effective mask — enforce via key class).
- `aliases`: ordered failover ladders. Hold = length 1; downgrade = longer.
- `projects`: `speed` 0 = slow lane (never contends); `mask` = alias order.
- `maxTokens`: per-class hard cap.

## Auth

`KEYS_FILE` (default `deploy/keys.local.json`):

```json
{ "factory": { "user": "factory", "class": "non-ux" },
  "you":     { "user": "you", "class": "ux" } }
```

`Authorization: Bearer <key>` or `x-api-key: <key>`. `/health` is open;
everything else is gated.

## Endpoints

| Route | Notes |
|---|---|
| `POST /v1/chat/completions` | proxied; body rewritten (model, max_tokens cap); `x-resolved-model` header on response |
| `GET /v1/models` | 9router arms not on cooldown (+ `cooling` list); project masks as fallback |
| `GET /health` | open; per-endpoint health |
| `GET /__queue` | key-gated; per-queued-request: project, alias, class, wait, score, candidates, **reason** (why waiting) |

## Run

```sh
LLAMA_URL unused (endpoints live in config)
PORT=8091 POLL_MS=2000 \
KEYS_FILE=deploy/keys.local.json \
CONFIG_FILE=deploy/switchboard.local.json \
node server.ts
```

## Tests

```sh
node queue.test.ts   # 27 unit: parse, auth, rewrite, pickNext, allDown
node e2e.mjs         # 28 e2e: auth, models, routing, failover, breaker, 503 all-down, queue order
```

## Deploy (local, <host>)

- `deploy/switchboard.local.json` — single local endpoint, 5 aliases,
  `default` project (speed 1, all aliases).
- `deploy/keys.local.json` — factory key (non-ux). chmod 600, gitignored.
- `deploy/.keys.env` — `FACTORY_KEY`. chmod 600, gitignored.
- `~/.pi/agent/models.json` — arc-proxy provider, 5 alias models.
- `arc-agents/config.json` — all aliases via `pi --model arc-proxy/<alias>`.

## Known limits (v1)

- No mid-stream failover (bytes already sent) — non-streaming retry once,
  streaming gets 502.
- No preemption (UX arrival aborting a non-UX inflight) — blocked on 103
  llama-server upgrade (pre-b5563, no slot abort).
- No per-project point budget / admin cap — single admin, JSON is the config.
- `spawn` endpoint type is config-shaped but untested against a live
  cli-proxy (separate slice).
