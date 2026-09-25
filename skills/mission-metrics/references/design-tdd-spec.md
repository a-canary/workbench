# Design-TDD spec — mission-metrics as TDD for design & UX

Aaron, 2026-07-20: "/mission-metrics is like TDD for the Design and UX.
Defining clear measurable goal posts, before development."

## Principle

A mission's approved metrics + gates are the **failing test suite** for its
design. Development exists to turn those verdicts green. Code written before
the gates are user-approved is a prototype — throw-away by definition.

| TDD | Design-TDD |
|---|---|
| Write a failing test | Grill mission → user-approved metrics + gates (`/mission-metrics`) |
| Red | Fence rows render NO-GO / verdict-less on `/m/:slug` |
| Make it pass | Build the pipeline/feature until gates read GO |
| Green | Phase gate holds (all conjunctions true) |
| Refactor, keep green | Hillclimb the scope; later phases keep earlier metrics in the gate, possibly at tighter bands |
| Never delete a failing test to pass | Never widen a gate to pass — changing a gate is a user decision |

## Lifecycle

1. **Red first.** Run `/mission-metrics` (HITL grilling) → audience, value,
   direct metric, proxy ladder with named Goodhart gaps, phase order, one
   `hillclimb(scope, metric, gate)` line per phase.
2. **Approve.** User sets `approved: <date>` on the mission section in `~/vault/missions.md` (loader cutover done 2026-07-22; MISSIONS.yaml retired).
   Until then: prototypes and exploration only, no durable build-out.
3. **Baseline.** Record the current value of every phase-1 metric in
   `objective_metrics` before any climb (no baseline = no delta).
4. **Green.** Build. `/m/:slug` is the test runner: each fence row shows
   value + GO/WATCH/NO-GO verdict + trend.
5. **Advance.** Phase gate holds → PR swaps the fence rows to the next
   phase's metrics; earlier metrics stay in the new gate's conjunction
   (no-regression, like a kept passing test) — and a phase may re-tighten
   an earlier metric's band (alpha `num_users>10, fps>20` → beta
   `num_users>100, fps>40`; latest band is live). The advance PR also
   greps in-scope `ponytail:` debt markers: ceiling hit by the next gate →
   pay before advancing, else the marker rides.

## Invariants

- One fence = current phase only. History lives in git, not the fence.
- Every fence row names its recorder + cadence in the goal text
  ("no recorder, no metric"). A pending recorder is stated as pending.
- Gates must be evalGate-parseable (band `N-M[%]` or count `N @ …`);
  bare counts are exact-match — use a band for floors (e.g. `20-99999`),
  and `hi>100` (e.g. `99-101%`) when GO at exactly 100% matters.
- Provenance: `user-directed` only for rows the user answered into
  existence; agent inference stays `inferred` and never sets `approved:`.
- Proxies carry their gap: each states what direct metric it stands in for,
  how it can move without the value moving, and what confirms it later.
- Scorers/judges are a different model than the producer (self-judge ≠ quality).

## Substrate (unchanged, see SKILL.md)

~/vault/missions.md `## <slug>` (mission + approval) → repo CHOICES.md phase plan + fence →
objective_metrics samples → `.arc/dashboard.json` charts → `/m/:slug` verdicts.
