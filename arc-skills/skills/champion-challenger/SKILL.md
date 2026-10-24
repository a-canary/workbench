---
name: champion-challenger
description: Design and run a champion/challenger loop — continuously A/B a known-good champion against a challenger, promoting only on a pre-registered gate. Use when building or reviewing a promotion gate, deploy ladder, model-promotion rule, A/B harness, backtest-before-deploy flow, or any "is this new version actually better, and safe to ship?" decision.
---

# Champion / Challenger

A self-improvement loop where the current known-good version (**champion**) keeps serving the real consequence while exactly one candidate change (**challenger**) is evaluated against it on a bounded slice. The challenger is promoted **only** when it clears a pre-registered gate. The whole discipline exists to answer one question safely: *is this new version actually better — and is it safe to ship?*

The same skeleton fits very different systems — a live trading strategy, an ML model in production, a web product. The five parts below are identical across them; only the instruments and constants differ. See [EXAMPLES.md](EXAMPLES.md) for all three worked side-by-side.

## The five parts — every C/C system needs all of them

1. **Champion** — current known-good, serving the real consequence (money / users / the baseline answer).
2. **Challenger** — exactly one isolated candidate, run on a *bounded* slice of the consequence (or offline replay first).
3. **Eval substrate** — the instrument(s) producing the comparison signal. **Every instrument has a blind spot; name it and cover it with a second instrument.**
4. **Promotion gate** — pre-registered, an **AND of independent conjuncts** (not one score), **immutable-downward**, decision collapsed to an **enum verdict**.
5. **Kill / rollback** — unconditional, instant, automatic; **asymmetric** to promotion (toward-risk is slow/gated, toward-known-good is fast/automatic).

> Missing one of the five is the gap to close — not a new metric. See [EXAMPLES.md](EXAMPLES.md) for how three different systems fill them in and which mechanics transplant between them.

## Designing a gate — the checklist

- [ ] **Pre-register** metrics, thresholds, sample/time floor, and exit plan *before* the run, in an immutable record (commit trailer / contract). The bar must not move after results appear.
- [ ] **Define the unit under test** with the *freeze-replay test*: what you freeze-and-vary is **system** (gate it); what you hold identical is **data** (CRUD it, don't gate it).
- [ ] **Make the gate an AND of disjoint conjuncts** — at minimum: *effect* ∧ *sample/time floor* ∧ *no guardrail tripped* ∧ *clean reasoning*. Each conjunct covers a different failure mode.
- [ ] **Pick instruments by blind spot**, not convenience — and write each blind spot down. (Offline can't see live shift; backtest can't see slippage; shadow can't see real fills; a self-judge can't see its own bias.)
- [ ] **Set a sample/time floor from the MDE** (statistical power), and make it **immutable-downward** — extendable, never shortenable. Good luck must not buy a shorter test.
- [ ] **Count and record N** — how many challengers/metrics/segments were tried — and raise the bar with it. The expected best-of-N score grows even at zero skill; a gate that ignores N auto-promotes noise. (Use *effective* N when candidates are correlated.)
- [ ] **Collapse the decision to an enum** the auto-path reads (`BEATS/TIES/LOSES`, `CLEAN/CONCERN/DISQUALIFY`) — never a raw float or free text. Goodhart-resistant.
- [ ] **Declare guardrail metrics** that block promotion when they regress, independent of the goal metric.
- [ ] **Scale the evidence bar + human sign-off to blast radius** (reversibility × compounding, *not* diff size). Toward-known-good can auto-promote; toward-irreversible may need a human.
- [ ] **Make rollback asymmetric**: the kill switch is unconditional/instant and never waits on the dwell. Reverting code must not require re-clearing the promote gate.
- [ ] **Add a watch stage**: promotion is not the end — watch the new champion against pre-declared revert triggers until *confirmed operational* (and *confirmed positive* for improvement claims).

## Before you trust a "win" — pitfall triage

A challenger looks better but isn't whenever the comparison is **contaminated** (leakage, look-ahead, survivorship), **noisy** (underpowered, peeking, multiple comparisons), **transient** (novelty, regime, distribution shift), **broken** (SRM, network effects, a vacuous no-op change), **self-graded** (Goodhart, self-judge), or **measured by the wrong instrument**. For each trap, why it fools you, and its guard, see [PITFALLS.md](PITFALLS.md).

## The one rule that subsumes the rest

**A single number going up is never sufficient evidence to promote.** Pre-register an AND-gate of disjoint conjuncts, measured by disjoint instruments whose blind spots you've named, collapse the decision to an enum, keep rollback instant and asymmetric, and watch after you promote.

## Files

- [GLOSSARY.md](GLOSSARY.md) — every term (champion, challenger, dwell, SRM, CUPED, blast radius, freeze-replay, Goodhart…), grouped, with common field synonyms.
- [EXAMPLES.md](EXAMPLES.md) — the shared skeleton worked side-by-side across three systems (a trading strategy / an ML model / a web product), a vocabulary map, and the mechanics worth transplanting between domains.
- [PITFALLS.md](PITFALLS.md) — false-promotion traps by domain (ML / web A/B / quant) + cross-cutting, each with its guard.

## Always-on rules (from AGENTS.md split)

- **No rate without power.** Sample size set by required confidence, not the cached artifact. Report Wilson 95% CI; overlapping CIs = same result — don't "reconcile" noise. >80% bar needs n≥230; underpowered → no point estimate.
- **Self-judge ≠ quality.** A producing model scoring against its own rubric proves consistency, not quality. Get a second *disagreeing* judge before claiming improvement; diminishing self-judge deltas = stop signal, not success.
