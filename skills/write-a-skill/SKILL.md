---
name: write-a-skill
description: Create new agent skills with proper structure, progressive disclosure, and bundled resources. Use when user wants to create, write, or build a new skill.
---

# Writing Skills

## Process

1. **Gather requirements** - ask user about:
   - What task/domain does the skill cover?
   - What specific use cases should it handle?
   - Does it need executable scripts or just instructions?
   - Any reference materials to include?

2. **Draft the skill** - create:
   - SKILL.md with concise instructions
   - Additional reference files if content exceeds 500 lines
   - Utility scripts if deterministic operations needed

3. **Review with user** - present draft and ask:
   - Does this cover your use cases?
   - Anything missing or unclear?
   - Should any section be more/less detailed?

## Skill Structure

```
skill-name/
├── SKILL.md           # Main instructions (required)
├── REFERENCE.md       # Detailed docs (if needed)
├── EXAMPLES.md        # Usage examples (if needed)
└── scripts/           # Utility scripts (if needed)
    └── helper.js
```

## SKILL.md Template

```md
---
name: skill-name
description: Brief description of capability. Use when [specific triggers].
---

# Skill Name

## Quick start

[Minimal working example]

## Workflows

[Step-by-step processes with checklists for complex tasks]

## Advanced features

[Link to separate files: See [REFERENCE.md](REFERENCE.md)]
```

## Description Requirements

The description is **the only thing your agent sees** when deciding which skill to load. It's surfaced in the system prompt alongside all other installed skills. Your agent reads these descriptions and picks the relevant skill based on the user's request.

**Goal**: Give your agent just enough info to know:

1. What capability this skill provides
2. When/why to trigger it (specific keywords, contexts, file types)

**Format**:

- Max 1024 chars
- Write in third person
- First sentence: what it does
- Second sentence: "Use when [specific triggers]"

**Good example**:

```
Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when user mentions PDFs, forms, or document extraction.
```

**Bad example**:

```
Helps with documents.
```

The bad example gives your agent no way to distinguish this from other document skills.

## When to Add Scripts

Add utility scripts when:

- Operation is deterministic (validation, formatting)
- Same code would be generated repeatedly
- Errors need explicit handling

Scripts save tokens and improve reliability vs generated code.

## When to Split Files

Split into separate files when:

- SKILL.md exceeds 100 lines
- Content has distinct domains (finance vs sales schemas)
- Advanced features are rarely needed

## Trigger: user-invoked vs model-invoked

Default **model-invoked with progressive disclosure**: the description is a context pointer; SKILL.md is the next disclosure layer; branch-only detail lives in reference docs behind further pointers. Contain context load by **aggregating related skills under one meta/topic skill** — one description in context, branches disclosed on demand — instead of N sibling descriptions. Reserve `disable-model-invocation: true` for skills whose trigger is undetectable from user phrasing (pure operator rituals); that trades context load for operator cognitive load. Model-invoked firing is probabilistic — sharpen the description's "Use when..." triggers rather than abandoning model invocation.

## Steering: leading words + leg-work

- **Leading words**: compress intent into a domain phrase with a strong prior ("vertical slice", "test seam", "single source of truth") and repeat it consistently through the skill. Verify it works: the phrase should reappear in the agent's reasoning traces. Agent not obeying → leading words inconsistent or weak, not more paragraphs.
- **Leg-work per step**: an agent that can see a later goal skimps on the current step (plan mode's "ask clarifying questions" rushes to "create plan"). To force depth on a step, split it into its own skill so the future phase is hidden.

## Structure: steps + reference, branch-gated

A skill = **steps** (procedure) + **reference** (supporting material). Reference used on every branch stays inline in SKILL.md; reference used on only some branches moves to a separate file behind a context pointer ("if updating X, read references/x.md").

## Pruning failure modes

- **Duplication** — each fact/template has one source of truth, incl. across reference files.
- **Sediment** — accreted contributions nobody dared delete; re-sort into branches or kill stale material dead.
- **No-ops** — run the **deletion test**: delete the paragraph; if the agent would behave the same without it (e.g. "write a good commit message"), it stays deleted. Commonest when an agent wrote the skill.

## Review Checklist

After drafting, verify:

- [ ] Trigger mode chosen deliberately (user- vs model-invoked, context vs cognitive load)
- [ ] Description includes triggers ("Use when...")
- [ ] SKILL.md under 100 lines
- [ ] Branch-only reference moved behind context pointers
- [ ] Leading words consistent; confirm they echo in reasoning traces
- [ ] Deletion test run on every paragraph (no no-ops, no sediment)
- [ ] No time-sensitive info
- [ ] Consistent terminology
- [ ] Concrete examples included
- [ ] References one level deep
