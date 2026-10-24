# arc-skills — CONTEXT

Leading-words vocabulary for the arc-* ecosystem. Each entry is a pattern or
concept that recurs across skills, plans, and designs. Use the leading word
to express the idea in one term; readers who don't know it look it up here.

Definitions only — no implementation, no spec, no decisions. For decisions
see [CHOICES.md](./CHOICES.md). For repo-local domain terms, each repo has
its own `CONTEXT.md` (arc-agents/CONTEXT.md for ledger substrate, etc.).

---

## Process shapes

- **CAM** — Collector / Adaptor / Monitor. Many cheap readers, one smart
  writer, one measurement loop. The general shape of any
  evidence⇒decision⇒measure system.
- **champion-challenger** — A/B promotion gate. A known-good champion keeps
  serving while a challenger is evaluated on a bounded slice; promote only
  on a pre-registered gate.
- **counsel** — 5-expert adversarial panel that stress-tests a decision
  across 2 rounds, then synthesizes a verdict.
- **diagnose** — reproduce → minimise → hypothesise → instrument → fix →
  regression-test. Skip phases only when explicitly justified.
- **hillclimb** — phase-gate climbing driven by `hillclimb(scope, metric,
  gate)` from CHOICES.md. Measure baseline, run challengers, promote on
  gate wins.
- **MVP** — minimum viable path. Smallest slice that proves value;
  deliberate shortcuts marked in-code; expand only on gate wins.
- **paper-prototype** — hand-execute a designed module end-to-end with
  live/near-prod data before writing code. Produces a spec delta.
- **replay** — capture one execution, replay against a candidate config in
  an isolated sandbox, diff. Use before promoting any change with
  consequences.
- **sprint** — re-entrant supervisor loop driving one thin vertical slice to
  evidence-backed done.
- **TDD** — test-driven development. Failing test before implementation;
  gate = green suite.
- **tracer-bullet** — thin vertical slice through the full stack with one
  deliverable and one acceptance bar.
- **wargame** — branching runbook that pre-simulates reality fighting back
  move-by-move. Each fork: trigger + countermove + abort condition.

## Invocation shapes

- **afk** — autonomous / headless. Runs unattended; observable mid-flight;
  evidence-backed done.
- **HITL** — human-in-the-loop. Work the operator must decide or action;
  cannot be afk-completed.

## Styles

- **caveman** — terse prose. Drop filler, articles, pleasantries; keep full
  technical accuracy.
- **ponytail** — minimum-effort engineering. Ladder: YAGNI → reuse →
  stdlib → native → existing deps → one line. Mark deliberate shortcuts
  with `ponytail:` comments naming the ceiling and upgrade path.

## Discipline shorthands

- **evidence-backed** — done only with logged proof (failing test,
  benchmark delta, error count). Unmeasured = not passed.
- **merge-on-clear** — promotion rule: merge once (1) independent reviewer
  clears AND (2) merge-gate green. Author never approves own work.
- **recency-gate** — verify the live file shape still matches the symptom
  before fixing. Journal entries record when a problem was *observed*, not
  whether it's still live.
- **subagent-distill** — subagents return findings, not dumps. Aim under
  ~500 tokens; for large artifacts, file path + one-line summary.

## Wargame concepts

- **abort condition** — observation that halts a wargamed action.
- **countermove** — counter to a failure signal during execution.
- **fork** — branching decision point in a runbook.
- **trigger** — the observation that activates a fork.