---
name: slow-lane
description: Route LLM calls for long-running, non-user-facing work (cron, pipelines, subagents, ETL, generation) through arc-llm-proxy's slow-lane aliases so they queue behind the local llama-server's idle slots instead of stealing them from interactive work. Use for any background/batch LLM call; NOT for user-facing/interactive requests (those use fast-lane aliases or direct models). Cron jobs must run without claude — slow-lane aliases only.
---

# slow-lane

`arc-llm-proxy` runs on the operator box (LAN `192.168.1.159`, local `127.0.0.1`) on port `8091`, fronting two upstream endpoints: the model box's llama-server (192.168.1.103:1234, Bonsai-27B) and the Veles cloud GPU (Qwen3.8-27B-GGUF via trycloudflare tunnel). One port, six role aliases — `/v1/models` is the whole model surface:

| alias | lane | use |
|---|---|---|
| `planning` | fast | interview, planning, design |
| `hard` | fast | difficult execution |
| `easy` | fast | cheap local tasks |
| `bench` | **slow** | benchmarks, evals |
| `driver` | **slow** | plan execution, orchestration |
| `hygiene` | **slow** | nightly self-improvement cron (dream/token-waste/adaptation-review/gap-remediate) |

Slow-lane aliases queue and dispatch only into idle slots, always reserving one slot for fast traffic. `#slow`/`#fast` on any alias overrides its lane.

## Rule

Long-running or non-user-facing LLM calls use a slow-lane alias (`bench`/`driver`). If it would wait, let it wait — that is the point. **Cron jobs never use claude** — they run on these free local models; compensate for model limits with pipeliner designs (small chained steps, explicit retries). Never hit `:1234` on the model box directly — you'd bypass the queue and starve interactive requests.

## Usage

```bash
source /home/aaron/repos/arc-llm-proxy/deploy/.keys.env   # FACTORY_KEY for cron/agent use
curl -s http://192.168.1.159:8091/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $FACTORY_KEY" \
  -d '{"model":"bench","max_tokens":512,"messages":[{"role":"user","content":"..."}]}'
```

- OpenAI-compatible; the proxy rewrites alias + suffix to the upstream model name before forwarding.
- Auth: `Authorization: Bearer <key>` (or `x-api-key`). The key IS the queue identity — per-key round-robin fairness, one request per key per cycle.
- `pi` clients: provider `arc-proxy` is registered in `~/.pi/agent/models.json` → `pi --model arc-proxy/bench -p ...`.
- The model is a thinking model: reasoning consumes `max_tokens` before `content`. Budget accordingly (20 tokens ≈ empty content).
- Set generous client timeouts — slow-lane requests block in the queue until a slot frees.
- Ops: `GET /__queue` (key required) → `{"queue":N,"inflight":N,"lastIdle":N}`; `GET /health` (open) → `{"ok":true}`.

## Upstream endpoints

| endpoint | host | model | auth |
|---|---|---|---|
| `e103` | llama-server 192.168.1.103:1234 (model box) | Bonsai-27B-Q1_0.gguf | none |
| `eVeles` | Veles cloud GPU, trycloudflare tunnel | unsloth/Qwen3.8-27B-GGUF | Bearer key in `deploy/veles.key` |

Dispatch ladder per alias: e103 first, eVeles failover on all six aliases (see `deploy/switchboard.local.json`). When e103 is down, slow-lane traffic runs entirely on Veles — still queued by the proxy, just no local interactive slots to protect. The tunnel URL is ephemeral (`*.trycloudflare.com`): if the Veles box re-exposes, update `eVeles.url` in the switchboard and restart the proxy.

## Proxy ops

- Source of truth: `~/repos/arc-llm-proxy` (git). Local run: `deploy/keys.local.json` (key→user, chmod 600), `deploy/aliases.local.json` (per-host alias map), `deploy/.keys.env` (key values, chmod 600, gitignored).
- Restart: kill by PID (`ss -ltnp | grep 8091`), then relaunch with `LLAMA_URL=http://192.168.1.103:1234 PORT=8091 POLL_MS=2000 KEYS_FILE=deploy/keys.local.json ALIASES_FILE=deploy/aliases.local.json node server.ts`. No hot reload — key/alias edits need a restart.
- Alias changes: sync per the `_note` in `aliases.default.json` (arc-agents config, pi models.json, this skill).
- Model box: single slot (`-np 1`) — one slow request at a time, others queue. llama-server currently runs WITHOUT `--mmproj` (vision off); enabling it needs an authorized restart.
- Restarting either service needs authorization — don't bounce it speculatively.
