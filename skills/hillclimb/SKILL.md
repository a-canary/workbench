---
name: hillclimb
description: Self-directed improvement loop that drives a repo's current phase gate green while holding all previous gates, promoting only on pre-registered gate wins. Use when a repo has unmet metric gates, on a scheduled climb tick, or when the user says "hillclimb", "climb the metric", or "drive the gate green".
---

# Hillclimb (phase-gate climbing)

Executes the eval lines `/apply-mission` landed. The contract: **gate =
all previous phases' metrics ∧ current phase's gate** — a climb that
regresses an earlier win doesn't count. A later phase may **re-tighten**
an earlier metric's band (alpha: `num_users>10 and fps>20`; beta:
`num_users>100 and fps>40`) — the carried metric holds at its latest band.

## Loop

1. **Parse** — repo CHOICES.md: current phase's
   `hillclimb(scope, metric, gate)` + the mission file it serves. Refuse to
   climb a `veto+skew` mission (never scored) or a metric whose proxy gap is
   unnamed — route back to /apply-mission instead.
2. **Measure baseline** — via the metric's named recorder into
   `objective_metrics`. No recorder → fixing that IS the first climb step.
   Rate metrics obey no-rate-without-power: Wilson 95% CI, required n
   before claiming movement; underpowered → collect samples, don't claim.
3. **Green already?** — gate passes at baseline → propose the
   phase-advance PR (swap the objectives-fence rows to the next phase's,
   per apply-mission §3) and stop. The advance PR also greps in-scope
   `ponytail:` markers and checks each named ceiling against the next
   phase's gate — ceiling hit → pay that debt (via /task, like any
   climb change) before advancing; otherwise the marker rides.
4. **Pick the gap** — highest-leverage change *inside scope* (scope is the
   only thing a challenger may touch). One challenger at a time.
5. **Challenge** — implement via [/task](../task/SKILL.md) (worktree, TDD,
   adversarial review). Promotion mechanics =
   [champion-challenger](../champion-challenger/SKILL.md): gate
   pre-registered before the run, challenger measured on the same recorder,
   promote only on gate-clearing win with no earlier-metric regression;
   otherwise revert cleanly.
6. **Re-measure + record** — new sample to `objective_metrics`; report
   **baseline → delta** with CI where applicable.
7. **Repeat or stop** — loop from 4. Stop rules:
   - 3 consecutive non-promoted challengers → park, report the wall, and
     name what's blocking (don't grind).
   - Metric moves but the direct value it proxies doesn't (check the named
     Goodhart gap) → halt and flag the proxy, never keep climbing it.
   - A cross-mission conflict appears (income vs societal-benefit veto, or
     intra-mission capital contention) → emit a tradeoff row for human pick;
     never resolve it yourself.

## Cadence

One-shot by default. A recurring scheduled climb = a [cam](../cam/SKILL.md)
gate (collectors measure, this skill is the adaptor, monitor checks the
delta stuck). Self-judge is not quality — promotion evidence is the
recorder's numbers, never the producing model's own scoring.
