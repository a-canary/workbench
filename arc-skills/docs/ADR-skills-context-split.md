# ADR: Split AGENTS.md — always-on rules vs situational skill-bound rules

**Date:** 2026-07-15  
**Status:** Approved, todo list created  
**Drivers:** 12.5KB dead context loaded every session (~90% of AGENTS.md never fires for the current task)

## Decision

Split `~/.pi/pi.md` (symlink → `arc-skills/AGENTS.md`) into:

1. **~2KB always-on rules** — universal principles that fire every turn, any task
2. **Situational rules moved to skills** — each skill's SKILL.md gets a one-liner referencing the rule it owns

And record skill management design decisions here in `docs/ADR-*.md` rather than loading an extra context file.

## Rationale

- Every session loads 14.5KB of AGENTS.md regardless of task
- Most rules (~40) fire in <5% of sessions — paper-prototype, Docker, wargame, hard-merge, etc.
- Skills already load conditionally via `/skill:name` — binding a rule to its skill means it loads only when that skill is invoked
- No new mechanism needed: skills just need a note in their SKILL.md

## Todo list

### Phase 1: Condense AGENTS.md to always-on only

- [x] Audit all lines in AGENTS.md → classify always-on vs situational
- [x] Write condensed AGENTS.md (~2KB, universal rules only) — commit `ddcfe62`
  - All 19 keep items preserved as one block
  - All remove items excised from file

### Phase 2: Update skill files with moved rules

- [ ] ponytail skill — add ponytail: marker debt-log convention if missing (already covered via ponytail skill doc)
- [x] dream skill — add self-healing recency-gate + opus+haiku-only diagnostics — commit `bddc50e`
- [x] task skill — add all-dev-in-worktrees rule — commit `b7dde9c`
- [x] api-providers skill — add no-LiteLLM rule (already present before ADR)
- [x] champion-challenger skill — add no-rate-without-power + self-judge≠quality — commit `9cd920c`
- [x] hard-merge skill — add red-gate + merge-own-PRs rules (adversarial-review pattern covers red-gate concept; explicit rule text already present)
- [x] craft-defaults skill — add UI copy + Gebrauchswert rules — commit `95a19bd`
- [x] paper-prototype skill — add paper-prototype-before-impl rule — commit `95a19bd`
- [x] define-mission skill — already covers undefined-mission
- [x] gap-remediate skill — add recency-gate rule — commit `9cd920c`
- [x] code-review skill — add no-rate-without-power — commit `95a19bd`
- [x] Create docker skill (~10 lines) — commit f8901c5
- [x] ubütquitous-language skill — no crossover with old AGENTS.md (check passed)

### Phase 3: Replace AGENTS.md on disk

- [x] Write new condensed AGENTS.md — commit `ddcfe62`
- [x] Verify symlink ~/.pi/pi.md still points to arc-skills/AGENTS.md
- [ ] Test: start a session, verify no broken behaviors
- [ ] Push arc-skills

### Phase 4: Verify

- [ ] Daily catchup session runs without missing rules
- [ ] /skill:dreem/gap-remediate loads its new rules correctly
- [ ] /skill:hard-merge loads red-gate and merge-rules
- [ ] /skill:paper-prototype loads paper-prototype-before-impl
- [ ] /task session loads worktree rule via task skill
- [ ] None of the removed rules were actually needed by a session that doesn't load the corresponding skill

