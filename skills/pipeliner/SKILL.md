---
name: pipeliner
description: Build/run pipeliner modules (npm pi-pipeliner) — defineModule/defineChain + Thompson sampling. Use when wiring scheduled jobs, multi-step LLM pipelines, or anything cron-driven.
---

# pipeliner

Import from `pi-pipeliner` (source `~/repos/pipeliner`). All modules `.ts` via `defineModule`.

## Contract

- `defineModule({ name, input/output schemas, run(), postApply?() })` — atomic single-turn ops; decompose multi-step work into chained modules, not one mega-prompt.
- `defineChain` composes modules; Thompson sampling picks among variant arms.
- Scheduling: system cron → shell → pipeliner module (module may call `claude -p "/skill"` — CLI+skill = one turn, not whole job). Never CronCreate inside workers.

## Rules

- "pipeline" from Aaron = this framework, always. "directly"/"agentically" = bypass it.
- Read `~/repos/pipeliner/README.md` for API detail before writing a new module — don't guess shapes.
