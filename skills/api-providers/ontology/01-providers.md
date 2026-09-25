# 01 — Providers

Public API providers. Keys live in the GPG `pass` store — never inline; pull at use.

| Provider | pass path | Base URL | Auth | Wire format | Health (2026-08-25) |
|---|---|---|---|---|---|
| anthropic | `api/anthropic/api-key` | https://api.anthropic.com/v1 | `x-api-key` + `anthropic-version: 2023-06-01` | **native Messages API** (not OpenAI-compat) | ❌ key dead 2026-07-02 (401) — rotate; real claude availability probed via cli-proxy |
| minimax | `api/minimax/api-key` | https://api.minimax.io/v1 | Bearer | OpenAI-compat | ✅ live (M2.7 + M3 probed 01:35Z). No public list API — static watchlist |
| openrouter | `api/openrouter/api-key` | https://openrouter.ai/api/v1 | Bearer | OpenAI-compat | ❌ 401 — key was in conjecture git history, rotate before public use |
| cerebras | `api/cerebras/api-key` | https://api.cerebras.ai/v1 | Bearer | OpenAI-compat | ❌ 402 quota. NOT for agentic work: per-model context cap + TPM quota trips on ~90k-tok requests. Short-prompt latency tier only (judges, classifiers, extract/rewrite) |
| chutes | `api/chutes/api-key` | https://llm.chutes.ai/v1 | Bearer | OpenAI-compat | ❌ 402 quota. Bulk cheap tokens on hot open models; expert-horde primary |
| huggingface | `api/huggingface/token` | huggingface.co hub | Bearer | hub API | model downloads, gated repos |
| vast | `api/vast/api-key` | vast.ai CLI | CLI auth | CLI | GPU leasing — see `/vast-cli`, `/vast-compute` |
| Veles (self-hosted, cloudflare tunnel) | `api/veles/api-key` | https://cia-balanced-sixth-tmp.trycloudflare.com/v1/ | Bearer | OpenAI-compat | ? (registered in pi as provider `Veles`). **Last-resort fallback endpoint** — captain policy 2026-08-24 |
| claude (OAuth, via cli-proxy) | `api/claude/oauth-token` | via cli-proxy http://127.0.0.1:7890/v1 | pool-managed | OpenAI-compat | Max quota, no per-token cost. Down with cli-proxy (see 04-hosts) |

## Rules

- All chat providers are OpenAI-compatible (`POST <base>/chat/completions`) **except anthropic** (native Messages API).
- No LiteLLM / multi-key proxies for public providers — direct API only; route via pipeliner/config (USER.md doctrine).
- Live per-model status: `~/vault/api/PROVIDERS.md` (generated hourly by `refresh.ts`; SoT = `~/vault/api/models.json`).
- A provider's `chat smoke` line in PROVIDERS.md is the trust signal: red smoke ⇒ every model in that provider is unusable, regardless of list-endpoint status.
