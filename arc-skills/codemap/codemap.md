---
generated: 2026-08-25T09:52:59.884Z @73baa98
project: arc-skills
ecosystems: [unknown]
source_files: 21
test_files: 1
graph_source: madge
graph_analyzed: true
dead_count: 1
untested_count: 1
cycle_count: 0
tool: codemap
---

# Codemap — arc-skills

> Deterministic static snapshot (no LLM). Re-run after changes and diff `codemap.json` to see what moved.

## Module shapes (LOC by module)
_Modules = import communities (Louvain over the import graph)._

- `skills` — 3954 LOC
- `bin` — 252 LOC
- `arc-agents` — 12 LOC

## Seams (cross-module import edges)

_none detected_

## Layout vs clustering (dir ↔ community)

_Modules grouped by import community, not folder. Disagreements are architecture leads._

_Layout and clustering agree — folders match import communities._
## Dead code candidates (1)

_Source files with no inbound import and not an entrypoint. Verify before deleting — dynamic/CLI/plugin loads aren't seen._

- `skills/jsonl-db/lib/jsonl-db.ts`

## Untested source (1)

_No test file imports it and no sibling test exists. Heuristic — wire up coverage for precision._

- `skills/jsonl-db/lib/jsonl-db.ts`

## Import cycles (0)

_none detected_

## Possible redundancy

_none detected_

## Config files (2)

- `.gitignore`
- `skills/fresh-deploy-friction/scripts/Dockerfile`

## Top external deps

- `pathlib` — 8 imports
- `sys` — 8 imports
- `json` — 7 imports
- `argparse` — 5 imports
- `datetime` — 4 imports
- `re` — 4 imports
- `node:fs` — 3 imports
- `fs` — 3 imports
- `tempfile` — 2 imports
- `os` — 2 imports
- `node:child_process` — 2 imports
- `node:os` — 2 imports
- `node:path` — 2 imports
- `bun:sqlite` — 2 imports
- `collections` — 2 imports
- `extract` — 2 imports
- `importlib.util` — 1 imports
- `subprocess` — 1 imports
- `bun:test` — 1 imports
- `node:url` — 1 imports
- `pkg` — 1 imports
- `typing` — 1 imports
- `pipeline` — 1 imports
- `readline` — 1 imports
- `path` — 1 imports

## Docs with frontmatter (89)

- `skills/adaptation-review/SKILL.md` — name=adaptation-review, description=>-, allowed-tools=Read, Write, Glob, Task, Bash
- `skills/adaptation-review/agents/regression-reviewer.md` — name=regression-reviewer, description=Review the last N days of dream/token-wa, tools=Read, Glob, Grep, Bash, model=opus
- `skills/anti-sycophancy/SKILL.md` — name=anti-sycophancy, description=Strip validating, hedging, and flatterin
- `skills/api-providers/SKILL.md` — name=api-providers, description=LLM/API provider registry — pass-store k
- `skills/apply-mission/SKILL.md` — name=apply-mission, description=Gap-analyse ALL axes in ~/vault/missions
- `skills/auto-oversight/SKILL.md` — name=auto-oversight, description=One headless oversight pass over the NEX
- `skills/berzerk/SKILL.md` — name=berzerk, description=>
- `skills/blog/SKILL.md` — name=blog, description=Pre-PR. Draft a blog entry and write it 
- `skills/cam/SKILL.md` — name=cam, description=>-
- `skills/capacity/SKILL.md` — name=capacity, description=Shared-capacity ledger + advisory router
- `skills/caveman/SKILL.md` — name=caveman, description=>
- `skills/champion-challenger/SKILL.md` — name=champion-challenger, description=Design and run a champion/challenger sel
- `skills/cli-proxy/SKILL.md` — name=cli-proxy, description=Local OpenAI-compatible LLM endpoint htt
- `skills/code-review/SKILL.md` — name=code-review, description=Review the changes since a fixed point (
- `skills/codebase-design/SKILL.md` — name=codebase-design, description=Shared vocabulary for designing deep mod
- `skills/codemap/SKILL.md` — name=codemap, description=Generate a deterministic PlantUML map + 
- `skills/coding-standards/SKILL.md` — name=coding-standards, description=Default language-routing, strictness, di, license=MIT
- `skills/counsel/SKILL.md` — name=counsel, description=Run an adversarial counsel session with 
- `skills/craft-defaults/SKILL.md` — name=craft-defaults, description=Default engineering posture for AI agent
- `skills/dart/SKILL.md` — name=dart, description=Frame the system before you act. Run a D
- `skills/decompose-skill/SKILL.md` — name=decompose-skill, description=Split a SKILL.md over 100 lines into foc
- `skills/define-mission/SKILL.md` — name=define-mission, description=HITL interview that defines or refines a
- `skills/design-an-interface/SKILL.md` — name=design-an-interface, description=Generate multiple radically different in
- `skills/design-taste-frontend/SKILL.md` — name=design-taste-frontend, description=Anti-slop frontend skill for landing pag
- `skills/diagnose/SKILL.md` — name=diagnose, description=Disciplined diagnosis loop for hard bugs
- `skills/director/SKILL.md` — name=director, description=AFK-capable mission driver that reads MI
- `skills/docker/SKILL.md` — name=docker, description=Docker discipline for mission automation, disable-model-invocation=true
- `skills/domain-modeling/SKILL.md` — name=domain-modeling, description=Build and sharpen a project's domain mod
- `skills/dream-insights/SKILL.md` — name=dream-insights, description=Show the latest dream journal and adapta, allowed-tools=Read, Glob, Bash
- `skills/dream-status/SKILL.md` — name=dream-status, description=Show dream processing state and today's , allowed-tools=Read, Glob, Bash
- `skills/dream/SKILL.md` — name=dream, description=Mine conversation history for Claude's o, allowed-tools=Read, Write, Glob, Task, Bash
- `skills/dream/agents/adapter.md` — name=adapter, description=Read the daily journal and make one syst, tools=Read, Glob, Grep, Edit, Write, Bash, model=opus
- `skills/dream/agents/collector.md` — name=collector, description=Page through a conversation session and , tools=Bash, Read, Glob, Task, model=haiku
- `skills/edit-article/SKILL.md` — name=edit-article, description=Edit and improve articles by restructuri, disable-model-invocation=true
- `skills/estate-hygiene/SKILL.md` — name=estate-hygiene, description=Audit the repo estate — verdict every re
- `skills/execute-wargame/SKILL.md` — name=execute-wargame, description=Execute a wargame runbook produced by /w, model=claude-sonnet-5, effort=high
- `skills/fable-mode/SKILL.md` — name=fable-mode, description=>
- `skills/feedback/SKILL.md` — name=feedback, description=Injects structured user feedback into a 
- `skills/fresh-deploy-friction/SKILL.md` — name=fresh-deploy-friction, description=Spin up a throwaway fresh-user container
- `skills/gap-remediate/SKILL.md` — name=gap-remediate, description=Nightly CAM adaptor over the agent knowl, allowed-tools=Read, Write, Edit, Glob, Grep, Bash
