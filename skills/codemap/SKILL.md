---
name: codemap
description: Generate a deterministic PlantUML map + snapshot report of a project via static analysis (no LLM) — module shapes, seams, dead code, untested code, redundancy. Use for a fast codebase snapshot, a dependency/architecture diagram, spotting dead/untested/redundant code, understanding an unfamiliar repo, or diffing structure before vs after a change.
---

# Codemap

Deterministic codebase snapshot. Static analysis only — **no LLM**, fast, repeatable. Run it before you touch code to orient, and after to see what moved.

Emits three artifacts into `<project>/codemap/` — **git-tracked, commit them**. They're an official structural reflection of the code, not a throwaway cache. Committing makes `git diff codemap/codemap.json` between any two commits a structural delta for free.

- `codemap.puml` — PlantUML component diagram (modules → seams, colored by signal)
- `codemap.md` — report with YAML frontmatter (totals, shapes, seams, dead, untested, redundancy, configs, docs)
- `codemap.json` — raw graph IR; commit it so `git diff` on it is a structural delta

## Quick start

```bash
npx tsx scripts/codemap.ts <project-dir>
# then read the report:
cat <project-dir>/codemap/codemap.md
```

No flags, no options — one fast best-quality process. Modules are grouped by import community (deterministic Louvain); output always lands in `<project>/codemap/`.

**Progress tracking is just git.** `codemap.json` is git-tracked, so git diffs structure for free — no flags, no extra artifacts:

```sh
git diff -- codemap/codemap.json               # vs last commit
git diff main -- codemap/codemap.json          # vs main
git diff <refA> <refB> -- codemap/codemap.json # any two refs
```

The IR is byte-stable across re-runs (only the timestamp line moves), so a clean diff means structure didn't change.

## When to use this vs improve-architecture (arc-agents)

- **codemap** — quick, deterministic, before/after a change. "What's the shape? what's dead? what's untested? what moved?" Seconds, no judgment.
- **improve-architecture** — slow, opinionated, LLM-driven deepening proposals against domain language + ADRs. Use codemap's output as its input.

## Reading the output

Open `codemap.md` first — it's the human view. Open `codemap.puml` in a PlantUML renderer (VS Code PlantUML ext, `plantuml codemap.puml`, or paste into a PlantUML server) for the picture.

Signal colors: **red = dead**, **orange = untested**, **purple = cycle**, **green = test**, blue = clean.

The signals are **heuristics with known false positives** — verify before acting. Definitions, caveats, tuning, and how to extend to other languages: see [SIGNALS.md](SIGNALS.md). Read it before trusting a "dead" or "untested" flag.

## Workflow: snapshot a change

1. Before editing: `npx tsx scripts/codemap.ts .` — skim `codemap.md`, note dead/untested counts and the seams you'll touch. Commit `codemap/` so this is the baseline.
2. Make the change.
3. After: re-run, then `git diff -- codemap/codemap.json` to see what moved (files +/-, newly-dead, cycles introduced/broken, seam-weight changes). Commit again so the next change diffs against this one.

## Notes

- Requires `node` + `npx tsx`. Optional: `madge` for an AST-accurate JS/TS import graph (recommended — `npm i -g madge`). Uses `git ls-files` when available (respects `.gitignore`), else walks and skips `node_modules`/`dist`/etc.
- Best on JS/TS. The import graph uses **madge** (AST-accurate) when installed (`npm i -g madge`) — it reads the syntax tree, so imports written inside comments or strings never leak in as fake edges/cycles. Without madge it falls back to a regex extractor, labelled `graph_source: regex (approximate)` with a warning, since regex can mis-read commented/quoted imports. Either way it resolves monorepo workspace package names (`@scope/pkg`) and tsconfig `paths` aliases, so cross-package imports show as real seams. Python/Go/Rust get coarse file inventory; the import graph is JS/TS-only — see [SIGNALS.md](SIGNALS.md).
- Commit the `codemap/` dir — it's a tracked reflection of the code. Regenerate and re-commit as part of the change so the diff travels with the PR. Progress tracking needs no special mode: git diffs the tracked `codemap.json` for you.
