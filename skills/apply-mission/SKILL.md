---
name: apply-mission
description: Gap-analyse all axes in ~/vault/missions.md against one repo's CHOICES.md Objectives and propose the missing objectives for approval. Use for a repo mission-coverage sweep, after /define-mission, or when the user says "apply the mission(s) to this repo", "gap-analyse axes", "propose objectives", or "add metric gates".
---

# Apply-Mission (repo-level, all-axis gap analysis)

Gap-analyses **every axis** in `~/vault/missions.md` — both the UM-xxxx
missions and the AGENTS.md principles it ranks — against **one repo's
`CHOICES.md` Objectives**. For each axis: is it *covered* by a live
objective, *n/a* for this repo, or a *gap*? Then propose the missing
interpretations. Metric-design method =
[mission-metrics](../mission-metrics/SKILL.md) §2-5. Output is a PROPOSAL —
the user approves.

This is the coverage sweep. To (re)interpret a single named axis in depth,
that is still §3-5 below, just scoped to one row.

## 1. Ground

Read the repo state (README, CHOICES.md incl. every `## Mission:`/`## Axis:`
section + the ```objectives``` fence, ADRs, recent work). Then read the axis
registry.

**Enumerate the full axis set** — do not stop at the UM-xxxx rows:

- **Principle axes** — the ranked principles at the top of `missions.md`
  ("## Ranking") that are defined in AGENTS.md, not as UM rules. Today:
  `hygiene` (rank 1), `use-value` (rank 2). These bind every repo and are
  the ones a single-mission apply silently skips.
- **Mission axes** — every `### UM-xxxx` rule in `missions.md`, and the
  machine-read rows in the last ```yaml fence under "## Registry".
- Record each axis's **kind** (`[veto]` vs scored) and **rank** — both
  change the verdict rule in §2.

Stale-premise gate: grep the live repo before calling anything "missing" or
"uncovered" — an objective may already cover the axis under a different name.

## 2. Verdict each axis (the gap matrix)

For every enumerated axis, assign exactly one verdict against the repo's
current Objectives:

- **covered** — a live objective row is tagged with this axis (UM-ID or
  principle slug) AND has a metric with a recorder landing samples. Cite the
  goal + metric. A row tagged but with `gate: none` / no recorder is
  **partial**, not covered — treat as a gap on the metric.
- **n/a** — the axis genuinely does not apply to this repo. One-line reason.
  Recorded so its absence reads as "judged n/a", not "gap".
- **gap** — the axis is relevant and no objective covers it (or only
  partially). This is what §3 proposes against.

**Veto axes are special.** A `[veto]` axis (Epistemic UM-0500, Societal
UM-0100, Security UM-0600) binds whether or not the repo scores it — its
enforcement is AGENTS.md rules + hooks, not an objective. So a veto axis with
no objective is **not automatically a gap**: mark it `veto-binds` unless the
repo can *actively advance* the value (e.g. webui *renders* the Epistemic
anti-rubber-stamp guard — that is an advanceable objective, propose it).
Never invent a scored metric for a veto's ethics — UM-0100's own rule is
"never scored"; a derived metric may only measure what was *done*, never what
was said.

Emit the matrix as a table — `axis | kind | rank | verdict | evidence/reason`
— so coverage is auditable at a glance. Every UM-ID and principle slug
appears in exactly one row.

## 3. Draft interpretations for the gaps

For each `gap` (and each advanceable `veto-binds`), draft a
`## Mission: <slug>` section for CHOICES.md (principle axes use
`## Principle: <slug>`):

- **Interpretation** — 2-4 sentences: how this repo serves the axis, which
  vetoes bind here and how (made concrete), which skews apply.
- **Objectives** — mission-metrics method: **direct** metric of the value
  first; nearest proxy only where speed demands, and then **name the
  Goodhart gap** + the eventual confirmation; phase order (phase 1 proves
  core value soonest; later gates keep earlier metrics in the conjunction).
- **One eval line per phase**:
  `phase N: hillclimb(scope=..., metric=..., gate=...)` — gates compose so
  no phase regresses a prior win.

Every objective/metric row NAMES its axis (UM-ID or principle slug) —
dashboards aggregate by axis; an untagged objective is a lint gap and
re-appears as uncovered on the next sweep.

## 4. Objectives fence (current phase only)

Append the gaps' current-phase rows to the repo's ```objectives``` fence:
`goal | provenance | metric | gate`, evalGate-parseable (band `N-M[%]` or
count `N @ ...`; `gate: none` for a watch-only row). Provenance:
`user-directed` from a live interview, else `inferred`. **No recorder, no
metric** — name the writer + cadence for each new metric's
`objective_metrics` samples in the same change. Advancing a phase is a later
PR that swaps the rows.

## 5. Propose for approval

Land the whole sweep as ONE proposal — the gap matrix + all drafted
sections + fence rows — via the apply-on-approve Lane-2 (webui) or a direct
PR to the repo's CHOICES.md. **Never merge the interpretation yourself; the
user approves** (agents do not self-approve mission expansion — UM-0300).
Batch with sibling repos from the same walk. Until approved, each gap axis
shows "uninterpreted" for this repo and only its global veto (if any) binds.

## 6. Baseline

Record the baseline sample for each new phase-1 metric before any climb
(measure-before-change). Then each phase is climbable via
[/hillclimb](../hillclimb/SKILL.md).

## Judging done

Every UM-ID and every ranked principle appears in the gap matrix with a
verdict (no axis silently dropped). Every `gap`/advanceable-`veto-binds` has
a drafted section + fence row + named recorder + recorded baseline. The
proposal is a PR, unmerged, awaiting the user.
