# Champion/Challenger glossary

The shared vocabulary for self-improvement-by-A/B. Terms are grouped: **core roles**, **the gate**, **the eval instruments**, **statistics**, **safety**. Common synonyms from each field are listed inline as *Also:*. For three worked examples instantiating these terms in a trading strategy, an ML model, and a web product, see [EXAMPLES.md](EXAMPLES.md).

## Core roles

- **Champion** — the current known-good version serving the real consequence (real money, real users, the production answer). The incumbent. Also: *control*, *baseline*, *production*, *active variant*.
- **Challenger** — exactly one candidate change being evaluated against the champion on a *bounded* slice of the real consequence or offline replay. Also: *treatment*, *variant*, *candidate*.
- **Candidate** — a pre-challenger change still proving itself offline (sim/log/staged) before it earns a challenger slot. Also: *staged variant*.
- **Promotion** — replacing the champion with the challenger once the challenger clears the gate. The only path toward more risk. Should be the *slow, gated, pre-registered* direction.
- **Reversion / rollback** — restoring the prior champion. The path back toward known-good. Should be the *fast, unconditional, automatic* direction.
- **Unit under test** — the thing the comparison is about: a *system change* (code/prompt/rule), a routing policy, a UI treatment, a strategy. Distinguish from **data** (see *freeze-replay test*).

## The gate

- **Promotion gate** — the pre-registered criterion a challenger must clear to be promoted. Best form: an **AND of independent conjuncts**, not a single score. Also: *promotion contract*, *promote rule*.
- **Pre-registration** — fixing the gate (metrics, thresholds, sample size, exit plan) *before* seeing results, so the bar can't move after the fact. The single strongest defense against self-deception — author the contract *before* the run.
- **Immutable-downward** — a gate constant (e.g. a dwell/sample floor) that a human may *extend* but never *shorten*. Good luck must not buy a shorter test.
- **Conjunct** — one independent requirement in an AND-gate (e.g. "≥5 days" AND "beats backtest" AND "no disqualify"). Collapsing two conjuncts into one re-opens a hole.
- **Enum verdict** — collapsing a rich/fuzzy evaluation to a small enum (`BEATS/TIES/LOSES`, `CLEAN/CONCERN/DISQUALIFY`) that the automated promote/revert path reads — never a raw float or free text. Goodhart-resistant: the automated decision can't be nudged by a fractional metric move.
- **Guardrail metric** — a metric that must NOT get worse, distinct from the metric you're trying to improve. A challenger that improves the goal metric but trips a guardrail does not promote. (Latency, crash rate, drawdown, refusal rate.)
- **Watch / monitor stage** — promotion is not the end: the new champion is watched against pre-declared revert triggers until *confirmed operational* (and, for improvement claims, *confirmed positive* in the live result).

## The eval instruments (and their blind spots)

The core discipline: **every instrument has a blind spot; name it and cover it with a second instrument.** A backtest can't see a broker-integration bug; a shadow run can't see real-fill slippage; an offline held-out set can't see distribution shift.

- **Offline / held-out evaluation** — scoring the challenger on a frozen dataset/replay. Cheap, fast, repeatable. Blind to: live distribution shift, integration faults, real-fill effects. *E.g. a backtest replay, or paired held-out scoring on a frozen corpus.*
- **Held-out set** — data the challenger was *not* trained/tuned on, used to estimate true generalization. Contamination (train/test leakage) silently inflates it; insist the split is *disjoint* and large enough to bound per-candidate noise.
- **Backtest** — replaying a strategy/system over an archived window. Edge instrument for trading; blind to slippage and tail events outside the window.
- **Shadow deployment** — running the challenger on real inputs in parallel, output logged but **not** served. Proves it doesn't crash on live traffic; consumes no consequence. Also: *quarantine*, *sim-and-log*.
- **Canary / capped exposure** — serving the challenger to a *small, bounded* fraction of the real consequence (a small % of traffic, a per-trade dollar cap). Proves real mechanics at limited blast radius. Also: *capped-live*.
- **Smoke / pre-flight gate** — a zero-consequence well-formedness check before any exposure (orders well-formed vs a live API, no crash). Not a validation tier; just catches malformed/crashing changes. (E.g. submitting orders against a paper-trading API to confirm they're accepted, before any real fill.)
- **Online controlled experiment (A/B test)** — randomly splitting the real population between champion and challenger and comparing outcomes with statistics. The gold standard for *causal* effect; needs power, randomization integrity, and guardrails.
- **Dwell** — a *clock* conjunct: enough real-exposure time/fills must elapse regardless of how good the result looks. Immune to persuasion.

## Statistics you must respect

- **Statistical power / MDE** — the smallest true effect (minimum detectable effect) your sample can reliably detect. Underpowered tests promote noise. Fix the sample size from the MDE *before* running.
- **Sample size floor** — a minimum-n conjunct below which the gate reports but never promotes (e.g. "≥300 held-out items for a binding verdict").
- **Peeking / p-hacking** — repeatedly checking an in-flight experiment and stopping when it looks significant. Inflates false positives massively. Fix: pre-set sample size, or use a *sequential test* designed for continuous monitoring.
- **Sequential testing** — a method (always-valid p-values, group-sequential, mSPRT) that *permits* continuous peeking without inflating error — the correct way to "watch it live."
- **Sample Ratio Mismatch (SRM)** — observed split (e.g. 49.3/50.7) differs from intended (50/50) by more than chance → the experiment is broken (bad randomization, logging loss, differential attrition); results are untrustworthy regardless of how good they look. A standard automated guardrail check.
- **CUPED** — variance-reduction using pre-experiment covariates; tightens confidence intervals so a real effect is detectable with less sample. (Booking/Microsoft technique.)
- **Novelty / primacy effect** — a challenger looks better (or worse) at first purely because it's *new*; the effect decays. Run long enough to see the steady state.
- **Simpson's paradox** — an aggregate win that reverses within every segment (or vice-versa), usually from an imbalanced mix. Segment before trusting an aggregate.
- **Multiple comparisons / best-of-N** — test enough challengers/metrics/segments and some will look significant by chance; the expected *best* score grows ≈√(2 ln N) even at zero true skill (N=10 ⇒ Sharpe 1.57 on pure noise). **Record N and raise the bar with it** (deflated-Sharpe / FDR); a gate that ignores how many candidates were tried auto-promotes noise. → see PITFALLS.md.
- **Deflated Sharpe Ratio (DSR)** — a multiple-testing-aware promotion threshold: promote only if P[true Sharpe > best-of-N noise benchmark SR₀] clears confidence, deflating for both trial count and non-normality (skew/kurtosis). The quant analog of a multiplicity-corrected significance gate.
- **Effective N** — when challengers are *correlated* (shared base, overlapping hyperparameters, reused features), the raw trial count overstates the multiplicity penalty; use an effective (smaller) N. Still an open problem for large model-variant pools and parameter sweeps.
- **Out-of-sample / walk-forward** — validating on a time period *after* the one used to fit; the trading analog of a held-out set, robust to look-ahead.

## Safety vocabulary

- **Blast radius** — the worst-case damage if the change is silently wrong (reversibility × compounding), *not* likelihood or diff size. Sets how much evidence is required.
- **Kill switch** — an instant, unconditional path that ends a challenger's exposure on any disqualifying signal, never waiting on the dwell. (E.g. a `DISQUALIFY` verdict or a drawdown breaker.)
- **Asymmetry principle** — promotion (toward risk) is gated/slow/may need sign-off; reversion (toward known-good) is unconditional/instant/automatic. The kill path never blocks on the promote conditions.
- **Fail-safe by asymmetry** — default to the recoverable outcome on any ambiguity (transmit only on positive allowlist match; everything unknown → dry-run). A false safe state is visible and recoverable; a false risky state is not.
- **Freeze-replay test** — *"Would replaying this on frozen inputs give the same result? What you freeze and vary = system (gate it); what you hold identical = data (CRUD it)."* Decides what even goes through the gate.
- **Goodhart's law** — "when a measure becomes a target, it ceases to be a good measure." Gating on a metric you also optimize invites gaming; mitigate with held-out judges, guardrails, enum collapse, and disagreeing evaluators.
- **Self-judge fallacy** — a model/strategy grading its own output proves *consistency*, not *quality*; a diminishing self-score is a stop signal, not a win. Get a disagreeing judge.
