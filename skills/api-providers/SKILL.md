---
name: api-providers
description: LLM/API provider registry — pass-store key paths, endpoints, per-provider model availability + warm status, intelligence scores, per-model notes, and routing guidance. Use when code or an agent needs an API key, is picking a provider/model for a job (interactive vs background/cron), or asks what models are available or warm — check the live doc before choosing.
---

# api-providers

**Full ontology** (providers, models, aliases, hosts, routing policy, sync points): `ontology/README.md` in this directory. Read the topic file when a routing/host/alias question goes beyond per-key lookup.

Keys live in the GPG `pass` store. Never inline; pull at use: `pass show api/<provider>/<entry>`.

## Keys + endpoints

| Provider | pass path | Base URL | Auth |
|---|---|---|---|
| anthropic | `api/anthropic/api-key` | https://api.anthropic.com/v1 | `x-api-key` + `anthropic-version: 2023-06-01` |
| minimax | `api/minimax/api-key` | https://api.minimax.io/v1 | Bearer |
| openrouter | `api/openrouter/api-key` | https://openrouter.ai/api/v1 | Bearer |
| chutes | `api/chutes/api-key` | https://llm.chutes.ai/v1 | Bearer |
| cerebras | `api/cerebras/api-key` | https://api.cerebras.ai/v1 | Bearer |
| claude (OAuth) | `api/claude/oauth-token` | via cli-proxy http://127.0.0.1:7890/v1 | Max quota — no per-token cost (see `/cli-proxy`) |
| huggingface | `api/huggingface/token` | huggingface.co hub | model downloads, gated repos |
| vast | `api/vast/api-key` | vast.ai CLI | GPU leasing (see `/vast-cli`, `/vast-compute`) |

All chat providers are OpenAI-compatible (`POST <base>/chat/completions`) except anthropic (native Messages API).

## Live doc (refreshed hourly by cron)

`~/vault/api/PROVIDERS.md` — per-provider model tables: availability, warm status, context length, intelligence score, memory-notes, plus a chat-smoke line per provider. Refreshed hourly by cron running `refresh.ts` (this skill dir); see `SETUP.md`.

The doc is GENERATED. Source of truth is `~/vault/api/models.json` (watchlist, intel scores, notes, optional `probe_model`). To add a model, bank a note, or record a score: edit `models.json`, then `bun ~/repos/arc-skills/skills/api-providers/refresh.ts`. Intel = curated score (Artificial Analysis index or internal ProgramBench) — filled by hand when measured, never guessed.

## Chat-smoke probe

`refresh.ts` does **two** probes per provider:

1. **List endpoint** (`p.list`) — model catalog, used to populate the per-model table.
2. **Chat smoke** (`p.probe_model` → `POST {p.base}/chat/completions` with `messages:[{role:user,content:ping}]`, `max_tokens:4`) — single-token ping, catches `list=200 but inference=402/429` (chutes subscription-cap case) and tests pool failover for cli-proxy.

Provider smoke result lands as a `> chat smoke:` line in PROVIDERS.md. If smoke fails, every model in that provider flips to `✗ quota` in the table. Set `probe_model` per-provider in models.json; absent = smoke skipped (the right call for anthropic, which is native Messages API, not OpenAI-compatible).

For **cli-proxy** specifically, set `base: http://127.0.0.1:7890/v1` with `probe_model: "smart"` — that exercises the full failover chain. A green smoke on `smart` doesn't prove each alias is live (one might be silently masked by another), but a red smoke means the whole pool is unusable. arc-skills deliberately knows nothing about cli-proxy internals — it's just another OpenAI-compat endpoint that happens to be local.

## Routing (captain standing plan 2026-08-27)

Three tiers, cheapest-first for routine work, escalation only when warranted:

1. **veles/qwen3.8-27b** — PRIMARY WORKHORSE: wayfinder, planning, grilling, driver, bench. Cloudflare tunnel (URL in `~/.pi/agent/models.json` provider `Veles`, model `unsloth/Qwen3.8-27B-GGUF`; key `api/veles/api-key`). Factory aliases: `planning` / `minimax-build` / `driver` / `bench`.
2. **llama-103/bonsai** — LITE REASONING: extraction, websearch, routing, hygiene. http://192.168.1.103:1234/v1, model `Bonsai-27B-Q1_0.gguf` (pi provider `llama-103`). Factory aliases: `easy` / `hygiene`.
3. **Opus-Medium** — defense and really difficult escalations ONLY. `claude` CLI in tmux|herdr (`claude-afk --model opus --effort medium`, OAuth key `api/claude/oauth-token`). Factory aliases: `hard` / `opus-max` (with Veles fallback candidate).

The factory lane encodes this table in `arc-agents/config.json` `exec_cli_alias` (direct providers, no proxy hop). Supersedes the 2026-08-24 "veles as last-resort fallback" policy — veles is now tier 1. Cloud endpoints (anthropic/minimax/openrouter/chutes/cerebras) stay available for explicit one-off use; they are not on default factory routing.

- **Short-context model** → route through pipeliner (`/pipeliner`): decompose into chained small modules instead of one long prompt — cheap short-context models stay usable.
- No LiteLLM / multi-key proxies — direct API only, route via pipeliner/config (USER.md doctrine).
