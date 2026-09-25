---
name: mission-metrics
description: Intense HITL grilling session that converges on a project's mission, audience, value delivered, metrics that measure that value, and a phase order with one hillclimb(scope, metric, gate) eval per phase. Use when starting a project/module/feature, when a dashboard is dead or verdict-less, or when the user says "define the mission", "what are we optimizing", "add metrics", or "set up hillclimbing".
---

# Mission-Metrics Grilling

TDD for design/UX: approved metrics + gates are the failing test suite written
before development — doctrine in [references/design-tdd-spec.md](references/design-tdd-spec.md).

A **HITL grilling session** (wayfinder-style): the agent asks **one question at
a time**, never answers its own questions, and between questions does the
legwork — read the repo, mine recent sessions, WebFetch competitor/domain
material — so each next question is sharper than the last. The user's answers
are the source of truth; research only shapes what to ask and what to propose.

The session converges on five artifacts, in order. Don't advance until the
current one is agreed in the user's own words (restate, get a yes):

## 1. Mission, value, audience

Grill until all three are one sentence each:
- **Who is the audience** — the specific person/group whose day changes.
- **What hurts** — the problem (mission = problem, not solution).
- **What value we provide** — the delta they experience when it works.

Research between questions: read README/CHOICES/ADRs for claimed intent, mine
recent sessions for what's actually being built, fetch how competitors frame
the same value. Contradiction between claim and behavior = your next question.

## 2. Direct metrics of the value

For the agreed value, **design the direct metric first** — the number that, if
it moved, the audience would verifiably be better off. Discuss it even when
it's expensive or slow (retention, comprehension, real-world action taken).

## 3. Nearest-proxy metrics

Where the direct metric is infeasible, slow, or blocks speed-to-market,
co-design the **nearest proxy**: cheaper/faster, causally closest to the
direct metric. For each proxy, state in one line (a) what direct metric it
stands in for, (b) the gap — how it could move without the value moving
(its Goodhart mission), (c) what would eventually confirm it against the direct
metric. Prefer a measurable proxy today over a perfect metric never.

## 4. Phase order

Sequence the metrics into **phases** by priority and speed-to-value: phase 1
is the single metric whose movement proves the core value soonest; later
phases layer in the direct/retention/quality metrics, usually **composing**
earlier ones so a later phase can't regress an earlier win. Grill the order —
"why is this first?" — until the user owns it.

## 5. Hillclimb spec per phase

Each phase gets exactly one eval line, machine-readable:

```
phase 1: hillclimb(scope=engagement_pipeline, metric=quiz_pass_rate, gate=quiz_pass_rate>80)
phase 2: hillclimb(scope=engagement_pipeline, metric=(quiz_pass_rate>80)*retention_rate, gate=quiz_pass_rate>90 and retention_rate>80)
```

- `scope` — the module/pipeline being climbed (what a challenger may change).
- `metric` — the number (or composition of earlier metrics) being maximized.
- `gate` — the pass condition that closes the phase and opens the next; later
  gates keep earlier metrics in the conjunction (no regressions) and may
  **re-tighten** their bands as the product matures — a game gates
  `num_users>10 and fps>20` in alpha but `num_users>100 and fps>40` in
  beta; the latest band is the live one.
Promotion mechanics per phase = [champion-challenger](../champion-challenger/SKILL.md);
a recurring scheduled climb = a [cam](../cam/SKILL.md) gate.

## Persist to substrate

This skill is the shared METHOD; the orchestrators are
[define-mission](../define-mission/SKILL.md) (mission-level interview + repo
walk), [apply-mission](../apply-mission/SKILL.md) (per-repo objectives +
gates proposal), and [hillclimb](../hillclimb/SKILL.md) (drive the gates
green). Every objective/metric names its mission slug.

Record the outcome on the surfaces that already render (create no new infra):

| Artifact | Lives in |
|---|---|
| Mission + approval | `~/vault/missions.md` `### UM-xxxx` rule (see `~/vault/missions-proposals/SPEC.md`; loader cutover done 2026-07-22 — registry lives in the missions.md yaml fence, MISSIONS.yaml retired) — `approved:` = date the USER approved the full definition; until set, agents do ONLY throw-away prototypes/exploratory work on the mission |
| Phase plan (hillclimb lines + proxy rationale) | target repo `CHOICES.md`, prose above the fence |
| Active phase's metrics | `CHOICES.md` ```objectives``` fence rows (`goal \| provenance \| metric \| gate`) |
| Samples | `objective_metrics(project, metric, value, recorded_at)` — **no recorder, no metric**: name the writer + cadence in the same change |
| Charts | lead repo `.arc/dashboard.json` → `/m/:project` |

Fence gates must be evalGate-parseable (band `N-M[%]` or count `N @ …`);
the fence holds the **current phase only** — advancing a phase is a PR that
swaps the rows. Provenance from this session = `user-directed` (the user
answered the questions); agent-only inference stays `inferred`. Record the
baseline sample for each phase-1 metric before any climb.

## Rules of the grilling

- One question per message. Many at once overwhelms.
- Never answer your own question or proceed on a guessed answer — this
  session only resolves through the live exchange.
- Interleave research between questions; cite what you found in one line
  when it motivates the question.
- Restate each agreed artifact before moving on; the user's "yes" is the gate.
- Push back: activity metrics ("PRs merged"), solution-shaped missions, and
  proxy metrics with no named gap all get challenged, not transcribed.
