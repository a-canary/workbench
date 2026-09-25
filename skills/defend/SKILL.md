---
name: defend
description: The Defend* gate family — named critical junctions where an independent model attacks the artifact before it crosses the seam. DefendPlan (opus, wayfinder→build), DefendMerge (workhorse, worker→git merge = /hard-merge), DefendDeploy (opus, QA+visual passed→production deploy), DefendConviction (opus, conviction change touching a held position → apply). Use when a plan is about to be dispatched to build, a diff is about to merge, anything is about to go public, or a conviction change is about to move/exit a held position.
---

# defend — critical-junction gate family

One seam concept, three named gates. At each gate an **independent** model
attacks the artifact before it crosses into the next phase. The name marks the
junction; the tier marks the cost.

## The pipeline

```
PLAN     User ⇄ Director.qwen ⇄ DefendPlan.OPUS ────────────► Driver
BUILD    Driver.qwen(delegates) ► Worker.qwen|bonsai ⇄ DefendMerge.QWEN ► git merge ► Driver
RELEASE  Driver(prototype) ⇄ QA.qwen ► User(webui review)
         Driver(plan) ⇄ QA.qwen ⇄ DefendDeploy.OPUS ► Driver(public deploy).qwen ► User(notify)
```

| Gate | Seam | Tier | File |
| --- | --- | --- | --- |
| **DefendPlan** | wayfinder result → build dispatch | counsel (5-expert panel) | [plan.md](plan.md) |
| **DefendMerge** | worker diff → git merge | workhorse, fresh context (= /hard-merge) | [merge.md](merge.md) |
| **DefendDeploy** | QA+visual passed → production deploy | counsel (5-expert panel) | [deploy.md](deploy.md) |
| **DefendConviction** | conviction change touching a held position → apply | counsel (5-expert panel) | [conviction.md](conviction.md) |

## Why this tiering

counsel (5-expert adversarial panel) only where the outcome is expensive AND hard to reverse: a bad plan burns
a whole sprint; a bad production deploy is public and affects real users;
a wrong exit realizes a loss and abandons a live thesis. Merges are frequent
and git-reversible,
so fresh-context workhorse independence is proportionate there. Counsel budget =
junction count, bounded by construction.

## Rubric rule — floor, not fence

Each gate has **mandatory lenses** (the rubric). The attacker must address
every lens explicitly; "no findings" is a valid answer per lens, silence is
not. After the lenses, the attacker runs **free attack** on anything else it
sees — the rubric is a minimum attack surface, counsel adapts to conditions.

## Verdict + override

All gates use the counsel verdict contract: `CLEAR | ATTACKS`, ranked,
each attack satisfiable. ATTACKS are surfaced **verbatim** to the caller —
never summarized away. An override (ship anyway) is a ledger event: gate,
attacks overridden, why. counsel/CLEAR is still an untrusted report — verify
checkable claims against source.

## Wiring points

- DefendPlan: director/wayfinder flow, before build dispatch (see plan.md).
- DefendMerge: /hard-merge IS this gate — same procedure, named here.
- DefendDeploy: after QA pass + human webui review, before public deploy
  (app version, YT video, X post, website content) — see release.md.
- DefendConviction: trading nightly grade → apply seam — when a conviction change
  exits or drops a held slot below floor (on-demand), plus the weekly audit of all
  held positions. Not in the hot path (that is the same-model layer) — see conviction.md.
