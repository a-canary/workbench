# 03 — Aliases

Three distinct alias systems. Do not conflate them.

## A. arc-llm-proxy role aliases (the factory lane)

Canonical set: `arc-llm-proxy/aliases.default.json`. Model name at the proxy: `arc-proxy/<alias>` (pi) or bare `<alias>` (curl).

| Alias | Lane | Model (aliases.default.json) | Use |
|---|---|---|---|
| `planning` | fast | unsloth/Qwen3.8-27B-GGUF | interview, planning, design — frontier-tier thinking only |
| `hard` | fast | unsloth/Qwen3.8-27B-GGUF | difficult execution: refactors, debugging, multi-step builds |
| `easy` | fast | Bonsai-27B-Q1_0.gguf | cheap local tasks: formatting, extraction, simple edits |
| `bench` | **slow** | Bonsai-27B-Q1_0.gguf | benchmarks and evals; queued, never starves interactive |
| `driver` | **slow** | unsloth/DeepSeek-V4-Flash-0731-GGUF | plan execution, orchestration |
| `hygiene` | **slow** | unsloth/Qwen3.8-27B-GGUF | nightly self-improvement cron (/dream, /token-waste, /adaptation-review, /gap-remediate) |

`#slow` / `#fast` suffix on any alias overrides its lane.

**Deploy reality (2026-08-25):** the live switchboard (`deploy/switchboard.local.json`) maps **all six aliases to the single endpoint `e103` = 192.168.1.103:1234 serving Bonsai-27B**. The per-alias model split above is the intended design; the local deploy has not wired the Veles/other endpoints into the switchboard. Consequence: 103 down ⇒ all six aliases dead.

## B. cli-proxy pools (the interactive lane)

Pool → ordered candidate list, defined in `~/vault/api/models.json` (`pools` key — edit there, restart cli-proxy). Served at `127.0.0.1:7890/v1` as model name = pool.

| Pool | Candidates (ordered failover) |
|---|---|
| `smart` | `pi/veles/qwen3.8/high` → `cli/claude/opus/low` |
| `fast` | `pi/llama-103/Bonsai-27B/med` → `pi/veles/qwen3.8/low` → `cli/claude/haiku/low` |
| `smart-test` | `pi/minimax-m3/med` → `pi/chutes/zai-org/GLM-5.2-TEE/med` |
| `fast-test` | `pi/chutes/google/gemma-4-31B-turbo-TEE` → `pi/minimax-m3/no-think` |
| `kimi` | `pi/kimi-k3/no-think` |

Routing tokens: `cli/<tool>/<sub>/<effort>` (CLI backends), `pi/<provider>/<model>/<effort>` (pi CLI), bare `<provider>/<model>` (HTTP APIs).

## C. arc-agents exec aliases (spawn commands)

`arc-agents/config.json` `exec_cli_alias`: alias → worker spawn command.

| Alias | Command |
|---|---|
| `planning` / `hard` / `easy` / `bench` / `driver` / `hygiene` | `pi --model arc-proxy/<alias> -p {prompt}` |

Pointers: `default_alias=planning`, `fast_alias=easy`, `smart_alias=planning`; every pointer must name a real key (schema-enforced since the 2026-08-26 ghost purge).
Fallback rule (`getAliasCommands`): **removed** — unknown alias now throws at dispatch, naming the bad alias and the known set (loud > masked). The old silent fallback to `default_alias` is exactly what hid the ghost aliases below.

## D. Profile → alias bindings

`arc-agents/profiles/*.json` `exec_cli_alias`:

| Profile | Bound alias | Status |
|---|---|---|
| developer | `hard` | ✅ real key (rebound 2026-08-26) |
| triage | `easy` | ✅ real key (rebound 2026-08-26) |
| admin | `easy` | ✅ real key (rebound 2026-08-26) |
| director | `planning` | ✅ real key (rebound 2026-08-26) |
| sprint | `planning` | ✅ real key (rebound 2026-08-26) |

**Ghost-alias ledger:** `minimax-build` (historically `claude --model minimax-m2.7 --effort high`, later `pi -p --provider minimax --model MiniMax-M2.7`) and `opus-max` were removed from config.json when the alias set moved to arc-llm-proxy, but profiles were never updated. Every ledger event reporting `engine-alias-no-work:minimax-build` is actually `engine-alias-no-work:planning` (the fallback) mislabeled — the named alias never existed at dispatch time. The minimax API itself was live (probed 2026-08-25); the failure was the fallback alias's dead local lane (103:1234).

**Fix (applied 2026-08-26, task `llm-routing-purge-ghost-aliases-loud-fal`):** profiles rebound to real aliases (table above); `getAliasCommands` throws on unknown alias instead of silently falling back; `default_alias` must name a real key (schema). Recovery sweep treats rows blocked on a ghost alias as unblockable-by-wait: it flips them `blocked→ready` for re-dispatch under current bindings (the dead engine can no longer recur), with an audit event naming the ghost.
