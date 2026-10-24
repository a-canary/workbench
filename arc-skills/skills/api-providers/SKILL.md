---
name: api-providers
description: LLM/API provider registry — pass-store key paths, endpoints, per-provider model availability + warm status, intelligence scores, per-model notes, and routing guidance. Use when code or an agent needs an API key, is picking a provider/model for a job (interactive vs background/cron), or asks what models are available or warm — check the live doc before choosing.
---

# api-providers

**Full ontology** (providers, models, aliases, hosts, routing policy, sync points): `ontology/README.md` in this directory. Read the topic file when a routing/host/alias question goes beyond per-key lookup.

Keys live in the GPG `pass` store. Never inline; pull at use: `pass show api/<provider>/<entry>`.

## Source of truth

All provider endpoint data (base URLs, pass paths, auth types, model watchlists, intel scores, notes) lives in **`~/vault/api/models.json`**. Read that file for current endpoints — do not trust inline tables in this skill doc (they rot).

```bash
# List all providers and their base URLs
jq -r '.providers | to_entries[] | "\(.key): \(.value.base)"' ~/vault/api/models.json

# Get a specific provider's pass path
jq -r '.providers.anthropic.pass' ~/vault/api/models.json
```

The live generated doc (refreshed hourly by cron) is at `~/vault/api/PROVIDERS.md` — per-provider model tables with availability, warm status, context length, intel scores. Source of truth is `models.json`; the doc is derived.

## Live doc (refreshed hourly by cron)

`~/vault/api/PROVIDERS.md` — per-provider model tables: availability, warm status, context length, intelligence score, memory-notes, plus a chat-smoke line per provider. Refreshed hourly by cron running `refresh.ts` (this skill dir); see `SETUP.md`.

The doc is GENERATED. Source of truth is `~/vault/api/models.json` (watchlist, intel scores, notes, optional `probe_model`). To add a model, bank a note, or record a score: edit `models.json`, then `bun ~/repos/arc-skills/skills/api-providers/refresh.ts`. Intel = curated score (Artificial Analysis index or internal ProgramBench) — filled by hand when measured, never guessed.

## Chat-smoke probe

`refresh.ts` does **two** probes per provider:

1. **List endpoint** (`p.list`) — model catalog, used to populate the per-model table.
2. **Chat smoke** (`p.probe_model` → `POST {p.base}/chat/completions` with `messages:[{role:user,content:ping}]`, `max_tokens:4`) — single-token ping, catches `list=200 but inference=402/429` (chutes subscription-cap case) and tests pool failover for cli-proxy.

Provider smoke result lands as a `> chat smoke:` line in PROVIDERS.md. If smoke fails, every model in that provider flips to `✗ quota` in the table. Set `probe_model` per-provider in models.json; absent = smoke skipped (the right call for anthropic, which is native Messages API, not OpenAI-compatible).

For **cli-proxy** specifically, set `base: http://127.0.0.1:7890/v1` with `probe_model: "smart"` — that exercises the full failover chain. A green smoke on `smart` doesn't prove each alias is live (one might be silently masked by another), but a red smoke means the whole pool is unusable. arc-skills deliberately knows nothing about cli-proxy internals — it's just another OpenAI-compat endpoint that happens to be local.

## Routing

Read `~/vault/api/models.json` for current provider routing, aliases, and tier assignments. The standing routing plan (cheapest-first, escalation on demand) is maintained in the JSON file's provider notes — do not hardcode routing decisions in skill docs.

The factory lane encodes this table in `arc-agents/config.json` `exec_cli_alias` (direct providers, no proxy hop). Supersedes the 2026-08-24 "veles as last-resort fallback" policy — veles is now tier 1. Cloud endpoints (anthropic/minimax/openrouter/chutes/cerebras) stay available for explicit one-off use; they are not on default factory routing.

- **Short-context model** → route through pipeliner (`/pipeliner`): decompose into chained small modules instead of one long prompt — cheap short-context models stay usable.
- No LiteLLM / multi-key proxies — direct API only, route via pipeliner/config (USER.md doctrine).
