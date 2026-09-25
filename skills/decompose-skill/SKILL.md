---
name: decompose-skill
description: Split a SKILL.md over 100 lines into focused sub-skills. Long skills lose model attention and overlap with siblings.
---

# decompose-skill

A SKILL.md over ~100 lines is a smell. The model reads less of it, the rules conflict, and the skill quietly grows into a department.

## When to invoke

- A skill file exceeds 100 lines of body content (frontmatter excluded)
- A skill has three or more distinct procedures embedded in it
- A skill's description tries to cover multiple verbs ("plan, build, and verify")

## Procedure

```
1. Read the skill end-to-end. List every distinct verb it performs.

2. Group verbs by:
   - Trigger condition (when does this fire?)
   - Output type (a plan? an edit? a report?)
   - Dependencies (does verb B always follow verb A?)

3. For each group, draft a new skill name and one-line description.
   The name should be a verb-phrase. The description should pass the
   "could the model pick this without reading the body?" test.

4. Split:
   - One SKILL.md per group, <100 lines each
   - Shared scaffolding goes in a sibling `references/` markdown file
   - Cross-link with [[skill-name]] where flow matters

5. Delete the original. Do not leave a stub that re-imports the children
   (that defeats the split).

6. Update any `MEMORY.md`, plugin manifest, or harness index that listed
   the old skill name.
```

## Red flags in the original

If the long skill has these, the split is overdue:

- Multiple `## When to invoke` sections under different headings
- Branching like "if X then do these 5 steps, else do these other 5"
- A FAQ section (means the skill doesn't tell the model what to do — it tells the human what the model will do)
- Embedded shell scripts longer than the prose

## Anti-patterns

- **Splitting by file size, not by behavior.** A 150-line skill that does one tight thing well stays one skill.
- **Splitting into a hub-and-spoke.** A "parent" skill that just calls children is more layers, not less. Either the children are siblings or the parent is the only skill.
- **Splitting too small.** A 10-line skill costs more in routing overhead than it saves in clarity.

## After splitting

Re-read each child as if you'd never seen the original. If a child's procedure is unclear without the parent's context, the split was wrong — merge differently.
