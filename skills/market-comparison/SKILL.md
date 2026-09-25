---
name: market-comparison
description: Wayfinder chart-template for public-facing output — cache market analysis (8 neighbors scored on industry-informed rubric, clone vs differentiate axes), gate ideate→develop and develop→publish, feed DefendPlan and DefendDeploy. Use when about to publish anything public (open-source repo, blog post, YouTube content, product launch, feature release, social post) or when the user says "market comparison", "neighbor analysis", "competitive landscape", "compare to what's out there", "is this worth building", "is this worth shipping". Inspired by the pi-vcc fork-and-upgrade flow.
---

# Market Comparison

A wayfinder **chart template** — produces a cached market analysis that gates public output. The analysis is **informed by neighbors** (not the reverse): study 8 neighbors first, observe their bars per dimension, then write the rubric with industry bars set at best-or-average. Each axis gets tagged **CLONE** (match — users expect it) or **DIFFERENTIATE** (beat best — our wedge).

## Two gates

| Gate | When | Pass condition |
|------|------|----------------|
| **ideate→develop** | After charting the map | ≥2 axes marked DIFFERENTIATE where no neighbor clears our bar |
| **develop→publish** | Before publishing | Re-score on same rubric — all axes meet bar, no regression vs plan |

Fail either gate → go back. No exceptions.

## Chart the map (wayfinder protocol)

Use `/wayfinder` to chart a `wayfinder:map` for the market. Standard ticket types apply (HITL vs AFK). See [MARKET-MAP.md](MARKET-MAP.md) for the full ticket template.

```
[1] grilling  (HITL)  Destination — name the space, audience, problem
[2] research  (AFK) ×8 Neighbor profiles — read the actual artifact, not landing page
[3] grilling  (HITL)  Rubric — axes from what neighbors cover; bars at best-or-average
[4] grilling  (HITL)  Clone vs Differentiate — tag each axis; set OUR bar
[5] task      (HITL)  ideate→develop gate — verify ≥2 DIFFERENTIATE gaps exist
   ↓ build phase (outside this skill)
[6] research  (AFK)   Re-score — score OUR artifact on same rubric, same evidence
[7] task      (HITL)  develop→publish gate — verify all axes clear, no regression
```

Tickets 2–7 are children of [1]. Wire blocking edges in a second pass so the frontier renders visually in beads.

## Rubric construction (the only part that needs judgment)

Axes come from **what neighbors actually cover**, not from our planned feature list. For each candidate axis, look across all 8 neighbors:

- **All 8 cover it** → mandatory axis (CLONE category) — users expect it; missing = instant fail
- **5–7 cover it** → common axis (mostly CLONE) — table stakes
- **2–4 cover it** → differentiator candidate (DIFFERENTIATE) — gap or wedge
- **0–1 covers it** → ignore unless the user argues for it

Aim for 5–8 axes. Each axis row in the cached rubric:

```
Axis              | Industry bar (best) | Industry bar (avg) | Our bar | CLONE/DIFF | Evidence
Accessibility     | 8                   | 5                  | 9       | DIFF       | repo: README opens in <2min
Latency           | 200ms               | 800ms              | 50ms    | DIFF       | benchmark: ./bench.sh
```

DIFFERENTIATE only where you can name a **concrete mechanism** that delivers the bar. "We'll be faster" without a mechanism is fiction.

## Cache + refresh (beads)

Each map = **one parent beads issue** (label `market-comparison:map`) with the 7 child tickets. The cache lives in `.arc/market/<slug>.md` — see [CACHE.md](CACHE.md) for schema.

Beads state drives refresh:

| State | Meaning | Next action |
|-------|---------|-------------|
| `open` | Map being charted | Resolve tickets in frontier order |
| `done` | Analysis current | Re-score on next publish event |
| `stale` | `next_due` passed or new neighbor appeared | Refresh before next gate |

A pre-publish hook + weekly cron check `next_due` and flip `done → stale` when overdue. `bd update <id> --set-state stale` is the operation; cron calls it.

## Defend integration

The cached analysis is not decorative — it feeds the defend gates as a mandatory lens:

- **DefendPlan** (wayfinder→build): attacker must address the rubric + clone/differentiate plan. "Your DIFFERENTIATE claim for axis X has no mechanism" is a valid attack.
- **DefendDeploy** (qa-passed→public): the develop→publish re-score is one artifact under attack. Any axis that regressed from plan = ATTACK.

See [defend/SKILL.md](../defend/SKILL.md) for gate mechanics; market-comparison's outputs are inputs to those gates, not replacements.

## Rules

- **Neighbors first, rubric second.** No rubric design before 8 neighbor profiles exist.
- **CLONE the boring stuff.** Don't reinvent what 8 neighbors already do well; spend the build budget on DIFFERENTIATE axes.
- **Mechanism, not intention.** DIFFERENTIATE requires a concrete mechanism. "Better UX" without one is wishful.
- **Score the artifact.** At publish, score what we shipped — not what we meant to ship.
- **Stale = invalid.** A stale cached analysis cannot gate a publish; refresh first or the gate fails closed.
