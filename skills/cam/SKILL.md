---
name: cam
description: 'Design a Collector/Adaptor/Monitor judgment gate — many cheap collectors read wide, one smart adaptor writes narrow, a monitor measures effect, all over one append-only ledger. Use when building or reviewing any recurring evidence⇒decision⇒measure loop: a self-healing cycle, a deploy/promotion gate, or any "agents gather evidence and exactly one decision gets written" design.'
---

# CAM — Collector / Adaptor / Monitor

Template for judgment gates: systems that periodically gather evidence, make one decision, and measure whether it worked. Three tiers, strict writer roles, one append-only ledger keyed `scope × round`. The ledger IS the audit trail — no side-channel state.

```
sources ──▶ collectors (N, read wide, cheap) ──append evidence rows──▶ ┐
                                                                       │
        adaptor (1, smart) ◀── reads evidence ─────────────────────────┤  ONE append-only ledger
            │ appends ONE decision row + makes ONE narrow write        │  keyed scope × round
            ▼                                                          │
        monitor (script; model only on anomaly) ──measurement rows──▶  ┘
                                          any tier may append a HALT row
```

## When NOT to use

CAM = **checklist + ledger + clock**. The pre-op checklist / post-op confirmation skeleton is the commodity core; CAM earns its complexity only via:

1. **Memory** — ledger correlates evidence/decisions/outcomes *across* rounds (Thursday's drift ↔ Tuesday's deploy).
2. **Cost discipline** — per-tier models + delta-gating, when checklist items are model calls.
3. **Clock** — monitor catches delayed effects and triggers revert; confirmation fires once, monitor keeps measuring.

Task needs zero of the three ⇒ write a 10-line checklist, not CAM. And mind the self-judge trap: a checklist re-asks the producer's own question — the monitor must grade measured outcomes, independent of the adaptor.

## Tiers and writer roles

- **Collectors** (read wide): agent | tool | script. Distill at write time — append curated evidence rows, never raw dumps; downstream reads pre-filtered. Delta-gate first: cheap probe against a watermark; nothing changed ⇒ zero model calls this round.
- **Adaptor** (write narrow): **sole writer of decisions.** All judgment concentrates here — the "judge" is the adaptor's acceptance check on collector evidence, not a separate box. Per round: one decision row + at most one narrow change. Multiple candidates ⇒ pick highest impact, log runners-up in the row. Can't decide ⇒ append halt/no-op row; never a partial write.
- **Monitor** (measure over time): ex-post — error/parity/cost/quality trends across rounds. Deterministic script; invoke a model only on anomaly. Replaces standing human review. Keep it independent of the adaptor — self-grading proves consistency, not quality.

## Interlocks vs gates

- **Interlocks** = deterministic invariants on the consequence path (caps, allowlists, circuit breakers). Code only, fail-closed, never wrapped in model judgment.
- **Gates** = judgment under uncertainty = CAM. Gates think; interlocks enforce gate outputs (adaptor decision becomes an interlock artifact; hard code caps stay as backstop).
Misrouting is the classic failure: model judgment on the consequence path, or humans hand-enforcing what code should.

## Models per tier — designation is MANDATORY

No defaults. The author designates a model per tier at design time, by error economics:

- **Collectors are recall-bounded** — a miss or false positive is corrected downstream by the adaptor's acceptance check. Cheap/mid tier is fine; spend on coverage, not per-call quality.
- **Adaptor is precision-bounded** — sole decision writer, nothing downstream corrects it before the consequence. Smartest tier you can justify.
- **Monitor** — script; designate a smart model for anomaly triage only.

Constraint: the claude-CLI Task loader honors only `opus | sonnet | haiku | inherit` — any other alias **silently falls back** to the default model. Provider/local models per tier are only viable after pipeliner conversion (below); pick within the honored set until then.

## Evidence contract — fail LOUDLY

- Every evidence row carries `asof` + a declared `max-age`.
- Stale or missing evidence ⇒ **named loud failure** (which collector, how stale) — never silent reuse of an old row. Silent-stale bugs sit consumed for days; loud contracts surface them in one round.
- Fail-open only with a declared reason in the ledger — and even fail-open logs loudly.

## Halt via ledger row

Any tier may halt the loop by appending a halt row; execution stays halted until a later row addresses it. No out-of-band kill files — halts live in the same ledger as everything else.

## Revertibility decides diligence

- **Revertible writes** ⇒ diligence shifts ex-post: monitor + **mandatory auto-revert** as the fail-response. Only required pre-stage = dry-run with deep inspection; heavier stages (backtest / shadow / staged rollout) are *optional evidence* the adaptor may demand, not a fixed ladder.
- **Irreversible writes** ⇒ diligence stays ex-ante: strong fail-closed validation before the write + interlock blast-radius caps.
- **Human = governor, not gate**: sets blast-radius bounds and reads monitor digests; no standing per-change approval.

## Standing watch → pipeliner conversion (required at install)

Prove before scaling: a new CAM instance runs first as a skill/agent flow. At install, register a standing watch wherever your reflection loop (e.g. `/dream`) tracks multi-day items — default `~/.claude/dream/state/watches.md`:

```
- [ ] <instance>: collect ~10 usage samples, then convert flow to a pipeliner
      module (defineModule/defineChain) and schedule via cron → shell → module.
      0/10 samples.
```

Conversion is also what unlocks non-Claude per-tier models (the Task-loader constraint above). No reflection loop installed ⇒ keep the watch note in the instance's own docs and review by hand.

## Worked examples (illustrative only)

- **Self-healing loop** (`/dream`): cheap collectors page session logs → append to a day-keyed journal (the ledger) → smart adapter makes exactly one system edit per run → a review skill monitors recent adaptations for regressions.
- **Daily trading gate**: collectors gather market evidence behind a watermark delta-gate (quiet day ⇒ zero model calls) → adaptor constructs one slate, fail-closed risk validator on top → cost/parity JSONL monitored across rounds; per-round artifacts dir for audit.

## Design checklist

- [ ] One append-only ledger, keyed scope × round; writer roles enforced
- [ ] Model designated per tier, with reason (recall vs precision)
- [ ] Collectors delta-gated and distilling at write time
- [ ] Adaptor: one decision row, one narrow write, fail-closed
- [ ] Evidence rows carry asof + max-age; staleness fails loudly
- [ ] Halt row honored by the executor
- [ ] Auto-revert exists before ex-ante gating is relaxed (revertible channel)
- [ ] Standing watch registered for pipeliner conversion
