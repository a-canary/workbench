# Hermes Integration Guide

This document explains how the `evolutionary` TypeScript library connects to the `evolutionary` Hermes skill (`~/.hermes/profiles/<profile>/skills/evolutionary/`).

---

## Architecture: Two Artifacts, One Purpose

| Artifact | Location | Purpose |
|----------|----------|---------|
| **Hermes Skill** | `~/.hermes/.../skills/evolutionary/` | Design contract: conventions, terminology, decision wizard, operator prompts, cross-project reference |
| **TypeScript Library** | `~/projects/evolutionary/` | Runnable implementation: EA lifecycle, caching, parallelism, backoff, log schema |

The skill tells agents **what to do** (conventions, naming, parameters, when to use each operator). The library tells agents **how to execute it** (the actual code).

---

## Hermes Skill Contents

```
evolutionary/
├── SKILL.md                           # Main skill — decision wizard + conventions
└── references/
    ├── starlight-schematic-ea.md     # Starlight's schematic-first pattern
    ├── cross-project-comparison.md    # 6 projects mapped to framework
    └── operator-prompts.md            # LLM crossover/mutation prompt templates
```

### SKILL.md

The skill is the **decision wizard**. When an agent needs to configure an EA loop, the skill guides it through:

1. **What is the artifact?** → Classify as free-text, structured-text, code, config-tuple, pipeline, concept
2. **How will you evaluate fitness?** → Choose method: pass-rate, metric, LLM-judge (rubric/pairwise), human-oracle
3. **Choose mutation operators** → Based on artifact type
4. **Choose crossover strategy** → Based on artifact type; when unsure, skip crossover
5. **Set parameters** → population_size, survival_rate, early_stop_rounds, etc.
6. **Define validation gates** → What must be true before evaluation
7. **Design the lineage log** → Where to write, what events to include
8. **Define termination** → Conditions that end the run

### operator-prompts.md

Copy-paste prompt templates for LLM-Taste operations:
- **LLM Crossover (unbiased mix-of-both)** — for free-text, structured-text, concept
- **LLM Mutation (semantic variation)** — for free-text
- **LLM Crossover (Structured-Text/SKILL.md)** — preserves YAML frontmatter
- **LLM Crossover (Pipeline manifest)** — for multi-stage pipelines

### cross-project-comparison.md

Maps 6 existing EA projects in the workspace to the framework:
- anti-sycophancy-benchmark (preamble evolution)
- hermes-agent-self-evolution (skill text via GEPA)
- m27-research-opt (pipeline arm search)
- benchmark/optimize-no-ledge (memory strategy)
- benchmark/evo (memory + KE co-evolution)
- starlight-slm (schematic-first)

Documents genome representation, eval method, operators, parameters, and fragmentation issues.

---

## Using the Library from a Hermes Cron Job

For long-running EAs (hours to days), use Hermes cron:

```yaml
# .hermes/profiles/<profile>/cron.yaml
- name: ea-preamble-continue
  prompt: |
    Continue the preamble evolution run. Read the current generation from
    the lineage log, evaluate any unevaluated individuals, select survivors,
    breed replacements, log all events.

    run_id: preamble_abc123
    log_path: /tmp/preamble_abc123/lineage.jsonl

    # Use the evolutionary library:
    #   import { EA } from '~/projects/evolutionary/src/index.js';
    #
    #   // Reconstruct state from log_path
    #   // Evaluate pending individuals
    #   // Select, breed, log
    #
    # If ea.isDone(): produce final report and send to user.
    # Else: continue.
  skills: [evolutionary]
  schedule: "0 */4 * * *"  # every 4 hours
```

---

## Hermes Profile State Per-Individual

Some EA use-cases run each individual in its own Hermes profile. When retiring an individual:

1. The `onRetire` hook is called
2. The agent should cleanup that individual's profile state
3. The EA loop continues without referencing the retired individual

```typescript
async function onRetire(ind: Individual, cause: RetireCause): Promise<void> {
  // Cleanup profile state if this individual ran in its own profile
  if (ind.genome._profileId) {
    await hermes.clearProfile(ind.genome._profileId as string);
  }
  // Archive to lineage if keeping lineage
  if (KEEP_LINEAGE) {
    await archiveIndividual(ind);
  }
}
```

---

## Connecting to llm-judge

For LLM-judge pairwise ELO evaluation, use the [`llm-judge`](https://github.com/a-canary/llm-judge) npm package or CLI:

```bash
# CLI — pairwise ELO across population
llm-judge elo --elo-rank 8 --prompt "Which is more helpful?" *.md
```

Or import the Python module directly in a evaluate callback:

```typescript
import { callLLMJudge } from 'llm-judge';  // Python via subprocess, or use CLI

async function evaluate(ind: Individual) {
  const candidates = allCurrentPopulation.map(i => i.genome._text);
  const result = await callLLMJudge(
    task: 'Which is more helpful?',
    candidates,  // array of strings
    model: 'claude-sonnet-4-6',
    provider: 'cli',
  );
  return { fitness: result.elo, metrics: {}, judgeOutput: '' };
}
```

The `llm-judge` CLI handles round-robin ELO computation. The EA library just calls it and gets a fitness score back.

---

## Quick Reference: ea-setup Decision Tree

```
Need to run an EA?
│
├─ Is the artifact code?
│   └─ Yes → Validation = syntax check + test suite
│           Mutation = AST edit or LLM refactor
│           Crossover = LLM merge or AST-level swap
│           Eval = test pass/fail + programmatic metrics
│
├─ Is the artifact a config tuple?
│   └─ Yes → Validation = enum membership per dimension
│           Mutation = dim-flip (weighted or uniform)
│           Crossover = single-point or uniform
│           Eval = programmatic score
│
├─ Is the artifact free text?
│   └─ Yes → Validation = wordcount bounds + prohibited phrases
│           Mutation = LLM mutation (70%) + random (30%)
│           Crossover = LLM crossover (unbiased mix-of-both) — NOT string concat
│           Eval = LLM-judge (pairwise ELO or rubric)
│
└─ Is the artifact a pipeline?
    └─ Yes → Validation = smoke test (run on dummy input)
            Mutation = stage swap or parameter change
            Crossover = stage subsequence swap or LLM merge manifest
            Eval = test pass + metric
```