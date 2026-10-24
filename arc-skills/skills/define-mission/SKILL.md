---
name: define-mission
description: HITL interview that defines or refines a global mission section in ~/vault/missions.md, then walks candidate repos dispatching /apply-mission. Use when a mission is proposed or undefined, needs refinement, or when the user says "define the mission", "new mission", or "refine the mission".
---

# Define-Mission (global level)

**Mission** = global value-dimension section (`### UM-xxxx`) in
`~/vault/missions.md`, abstract, applied to all projects; repos interpret it
locally via `/apply-mission` into a CHOICES.md `## Mission:` section.
**Axis** = the superset: missions + global principles (defined in AGENTS.md);
missions.md holds the axis ranking (hygiene, use-value ranked; prove-before-scale,
why-before-how always-on unranked), position = rank, vetoes bind by kind at any rank. Spec: `~/vault/missions-proposals/SPEC.md`.

## Detection triggers (run this skill when…)

- A conversation, PRD, or objective names a goal that maps to **no existing
  mission** (grep `^### UM-` ~/vault/missions.md).
- A new value-dimension is proposed ("we should also care about X").
- An objective/metric row carries no mission tag and none fits.

Never proceed to PRD/issues/implementation on an unmapped goal — define or
extend the mission first.

## 1. Interview

Grilling method = [mission-metrics](../mission-metrics/SKILL.md) rules: one
question at a time, never answer your own question, research between
questions (read repos, mine sessions, web). Converge, in the user's own
words, on:

- **Mission** — the goal-dimension, problem/direction-shaped, not a solution.
  Abstract enough to apply across projects.
- **Slug** — append-only once minted; check collision with existing slugs
  and aliases.
- **Type** — `bounded` (needs a cap + satisficing semantics: at/above cap,
  stop optimizing and yield tiebreaks) or `unbounded` (needs a `mode`:
  `direction` = climbable, or `veto+skew` = NEVER scored — no number to
  Goodhart; it only blocks and tie-breaks).
- **Values** — the rules applied to ALL projects (vetoes, skews,
  preferences). Vetoes apply globally even where a repo has no
  interpretation yet.
- **Aliases** — legacy mission slugs/stamps this mission absorbs.

Push back: solution-shaped missions, scoreable ethics, bounded missions without a
cap, overlap with an existing mission (refine that one instead).

## 2. Write the mission file

`~/vault/missions.md` `### UM-xxxx` rule — Supports line `slug, mission, type, cap|mode,
values, aliases, approved` + prose body (direction + values list).
**`approved: null` always — only the user sets the approval date.** Until
approved, agents do only throw-away/exploratory work on the mission. Commit to
vault.

## 3. Walk the repos

Enumerate candidates: `~/repos/*`, aliases' legacy subscribe lists, repos
whose CHOICES/README plausibly touch the mission. For each, judge relevance in
one line; for each relevant repo dispatch
[/apply-mission](../apply-mission/SKILL.md) (batch the resulting proposals
for one approval pass). The walk may run pre-approval: its outputs are
user-gated proposals, i.e. throw-away until approved. Irrelevant repos get a recorded `n/a` — absence of
an Mission section then reads as "judged n/a", not "gap".

## 4. Persist

Bank the definition + repo-walk verdicts to ke; memory pointer if the mission
changes standing doctrine.
