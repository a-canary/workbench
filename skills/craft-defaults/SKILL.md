---
name: craft-defaults
description: Default engineering posture for AI agents — weight quality and maintainability far above agent effort, no co-author trailers, never hand-edit generated files, one sentence per line in markdown, reproduce bugs E2E before fixing, scrutinise UI to pixel-perfection. Use when making an engineering trade-off, writing a commit message, editing files, writing docs/markdown, fixing a bug, or E2E-testing a UI.
---

# craft-defaults

Six defaults for how an AI agent should build, commit, document, debug, and test.
They are posture, not process — apply them by default and only deviate with a stated reason.

## 1. Effort is cheap; quality is the budget

When choosing between options, weight quality, modularity, and maintainability heavily and weight implementation time/effort near zero.
Pick the cleaner, more modular, more maintainable solution **even when it is more work**.

Why: an AI agent makes exploration and iteration cheap and fast, so the classic reason to cut corners — scarce human hours — mostly no longer applies.
Spend the freed budget on higher quality and effort targets, not on shipping the first hack.

This is the *how-well* axis, not the *whether* axis.
It does **not** license speculative abstraction or building what isn't needed — that's still YAGNI / ponytail's call.
ponytail decides whether a thing should exist; craft-defaults decides that the thing you do build is done well.

## 2. No agent co-author trailer

Never auto-append a `Co-Authored-By:` line naming the agent or model to a commit message.
The human owns the commit; do not co-sign it on the agent's behalf unless explicitly asked.

## 3. Never edit auto-generated files

Do not hand-edit generated artifacts — lockfiles, build output (`dist/`, `build/`), codegen output, snapshots, `*.generated.*`, anything carrying a `@generated` / `DO NOT EDIT` banner or marked `linguist-generated`.
Change the source, template, schema, or generator and regenerate.
An edit to a generated file is overwritten on the next build and hides the real fix.

## 4. One sentence per line in long markdown

In a long markdown file, put each full sentence on its own line.
Preserve normal Markdown structure — headings, lists, tables, code fences, blank-line paragraph breaks all stay as usual.
Only the prose changes: do not reflow or wrap multiple sentences onto one physical line.

Why: a reworded sentence then touches exactly one line, so diffs stay clean and review stays cheap.

## 5. Reproduce before you fix

Start every bug fix by reproducing the bug end-to-end, as closely aligned to the bug report as possible.
A real repro confirms you are chasing the actual symptom rather than a plausible guess, and it walks you to the root cause instead of a surface patch.
For hard, flaky, or performance bugs, escalate to the `diagnose` skill's disciplined loop.

## 6. Pixel-perfect UI

When E2E-testing a product, scrutinise the UI obsessively and be picky about what you see.
If something looks off — misalignment, spacing, contrast, jitter — fix it, even when it falls outside the task's stated scope.
UI bugs are rarely isolated: one visible glitch usually signals more behind it.

## When NOT to use

- A throwaway prototype or spike where the artifact is discarded — rules 1, 4, and 6 relax; rules 2, 3, 5 still hold.
- The user explicitly asked for the quick/minimal version — honour that over rule 1.

## Always-on rules (from AGENTS.md split)

- **UI copy: casual + terse, no visible timestamps.** Short verbs (`Pick`, `Send`), terse empty states (`nothing pending`). Keep timestamps in the data layer for sort/staleness; never paint them on the surface.
- **Gebrauchswert: functionality before|over visual appeal.** Optimize the practical value a user derives from everyday functionality, not visual appeal. Feature/design forks default to the option that does more daily work; polish serves use, never the reverse.
