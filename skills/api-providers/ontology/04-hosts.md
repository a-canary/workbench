# 04 — Hosts & Routers

Every process that fronts an LLM, and the machines underneath.

## Routers (OpenAI-compatible gateways)

| Router | Address | Runs on | Auth | Config | Health 2026-08-25 |
|---|---|---|---|---|---|
| **arc-llm-proxy** (switchboard) | `http://127.0.0.1:8091/v1` (LAN `192.168.1.159:8091`) | operator box | Bearer `FACTORY_KEY` (`source arc-llm-proxy/deploy/.keys.env`) | `switchboard.default.json` + `deploy/switchboard.local.json` (local wins) | ✅ up |
| **cli-proxy** | `http://127.0.0.1:7890/v1` | operator box (systemd user unit `cli-proxy.service`) | none local | pools in `~/vault/api/models.json` | ❌ down |

### arc-llm-proxy contract

- Model name: `<project>/<alias>` (bare alias → `defaultProject`). Unknown project/alias or alias outside project mask → 400 naming known values.
- Two queues (UX, non-UX); UX drains first (hard floor). Within queue: `score = wait_ms × project.speed`, ties FIFO.
- Endpoint ladder per alias = ordered failover. 429/5xx trips breaker (default 5 min), request requeues to next candidate. All candidates unhealthy → immediate 503 (fail fast, client backs off).
- Per-class `max_tokens` cap at body rewrite (ux 16384 / non-ux 16384 in local deploy).
- Slow lane: `bench`/`driver`/`hygiene` dispatch only into idle slots, always reserving one slot for fast traffic.
- Ops: `GET /__queue` (key) → `{queue, inflight, lastIdle}`; `GET /health` (open) → `{ok:true}`.
- Switchboard `endpoints`: currently **only `e103`** (`http://192.168.1.103:1234`, Bonsai-27B). The README documents `spawn`-type and multi-endpoint ladders (e.g. `eclaude` → cli-proxy) — not wired in the live deploy.

### cli-proxy contract

- Pool aliases (`smart`/`fast`/…) resolve to ordered candidate lists; per-alias health on its own health endpoint, not in PROVIDERS.md.
- Green `smart` smoke ≠ every alias live (one can mask another); red smoke = whole pool unusable.

## Model hosts

| Host | Address | What | Health 2026-08-25 |
|---|---|---|---|
| GPU box (4060) | `192.168.1.103:1234` (llama.cpp) | Bonsai-27B-Q1_0.gguf — the factory workhorse | ❌ down (human-gate `hg-arc-director-gpu-box-103-down-1787548017`) |
| Operator box | `192.168.1.159` | runs both routers | ✅ up |
| LM Studio box | `100.73.201.58:1234` | Bonsai-27B (64k), qwen3-4b, qwen3.5-9b distills | ? not probed |
| Veles (self-hosted) | `https://cia-balanced-sixth-tmp.trycloudflare.com/v1/` | Qwen3.8-27B, DeepSeek-V4-Flash, Cold-Fusion — **last-resort fallback** | ? not probed |
| vast.ai boxes | ephemeral | training/eval only — see `/vast-cli`, `/vast-compute` | lease-based |

## Rules

- **Never hit `:1234` on the model box directly** — bypasses the queue, starves interactive requests.
- Public provider endpoints: see [01-providers.md](01-providers.md).
- Host health is not in PROVIDERS.md (that doc covers public providers + cli-proxy smoke only). The arc-llm-proxy + 103 + LM Studio + Veles rows above are manual — probe `:8091/health`, `:1234/health`, and `curl -m 3 <host>/v1/models` when in doubt.
