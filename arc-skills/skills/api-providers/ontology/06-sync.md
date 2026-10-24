# 06 — Sync Points

There is no generator. When any one of these changes, **every** one of these must change in the same commit/PR. This file is the checklist.

## Change: alias set (add/rename/remove a role alias)

1. `arc-llm-proxy/aliases.default.json` — canonical alias → model → lane
2. `arc-llm-proxy/switchboard.default.json` — alias → endpoint ladder
3. `arc-llm-proxy/deploy/switchboard.local.json` — live local deploy override
4. `arc-agents/config.json` — `exec_cli_alias` entry + `default_alias`/`fast_alias`/`smart_alias` pointers
5. `~/.pi/agent/models.json` — `arc-proxy` provider model list
6. `arc-agents/profiles/*.json` — any profile bound to the alias (check for ghosts)
7. `arc-skills/skills/slow-lane/SKILL.md` — alias table
8. **this ontology** (`03-aliases.md`, `05-routing.md`)

## Change: endpoint / host (new model box, new provider, endpoint move)

1. `arc-llm-proxy/switchboard.default.json` + `deploy/switchboard.local.json` — `endpoints`
2. `~/.pi/agent/models.json` — provider entry (baseUrl, models, ctx)
3. `~/vault/api/models.json` — provider entry (base, pass, auth, list, probe_model) + `pools` if cli-proxy should route to it
4. `arc-skills/skills/api-providers/ontology/01-providers.md` / `02-models.md` / `04-hosts.md`
5. `pass` store — key present before anything routes to it

## Change: cli-proxy pools

1. `~/vault/api/models.json` — `pools` (edit there, restart `cli-proxy.service`)
2. `arc-skills/skills/api-providers/ontology/03-aliases.md` §B

## Change: routing policy (lane rules, last-resort, cron rules)

1. `arc-skills/skills/api-providers/ontology/05-routing.md`
2. `arc-skills/AGENTS.md` — model-routing rules (agent-visible)
3. `arc-skills/skills/slow-lane/SKILL.md` — if lane semantics change

## Known sync debt (2026-08-25)

- Ghost aliases `minimax-build` (developer/triage/admin) and `opus-max` (director/sprint) in `arc-agents/profiles/*.json` — see 03-aliases.md §D.
- `aliases.default.json` per-alias model split (Qwen3.8/Bonsai/DeepSeek) not reflected in the live switchboard (all → e103/Bonsai).
- `arc-llm-proxy/README.md` example config shows multi-endpoint ladders not present in any live switchboard.

## Proposed fix (not built)

Generate the derived files from one source: `aliases.default.json` + `switchboard.*.json` + `models.json` → emit `config.json` exec_cli_alias block, `~/.pi/agent/models.json` arc-proxy block, slow-lane table, and this ontology's tables. Until then, this checklist is the gate: a PR touching one sync point without the rest does not merge.
