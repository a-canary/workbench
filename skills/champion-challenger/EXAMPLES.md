# Champion/Challenger — three worked examples

The same pattern, instantiated in three very different systems. The skeleton is identical; the *instruments* and *gate constants* differ because the blast radius and the noise floor differ. Read [PITFALLS.md](PITFALLS.md) for the failure modes these designs defend against, and [GLOSSARY.md](GLOSSARY.md) for the terms.

The three examples:

- **Strategy** — a live trading strategy where the consequence is real money.
- **Model** — an ML model (or model + adapters) serving predictions in production.
- **Product** — a web product where the consequence is real-user behavior.

## The shared skeleton (all three)

1. **Champion** = the current known-good, serving the real consequence (real money / real predictions / real users).
2. **Challenger** = exactly one candidate change, isolated, run on a *bounded* slice of the real consequence (or offline replay).
3. **Eval substrate** = the instrument that produces the comparison signal — and its *blind spot* is named, so a second instrument covers it.
4. **Promotion gate** = a pre-registered **AND of conjuncts** (not a single score), immutable downward, collapsed to an **enum verdict** not a raw float.
5. **Kill / rollback** = unconditional and instant; *asymmetric* to promotion (toward-risk is gated/slow, toward-known-good is automatic/fast).

If your design is missing one of these five, that's the gap to close — not a new metric.

## Side-by-side

| | **Strategy** (live trading) | **Model** (ML in production) | **Product** (web) |
|---|---|---|---|
| **Champion** | the deployed strategy placing real-money orders | the model (+ adapters) currently serving predictions | the canonical UI variant users see |
| **Challenger** | a candidate strategy on a **capped-live** slice (small per-trade cap) | a candidate model / adapter / routing policy | a new UI treatment behind a flag |
| **Candidate (pre-challenger)** | a strategy in sim/replay only, not yet placing real orders | a model still proving itself on offline eval | an unlisted variant not yet in the split |
| **Unit under test** | a **system change** (logic/rule/params) — defined by the freeze-replay test | a topology / routing policy / a single adapter | a UI treatment |
| **What is NOT under test (data)** | market data, watchlists, position targets → runtime CRUD, never the gate | the training corpus rows; the routing *labels* (don't gate on data the model shouldn't see at serve) | feedback content; user rows |
| **Offline edge instrument** | **backtest replay** over an archived window | **held-out evaluation** on a frozen, disjoint corpus | (often none — the live A/B is the first real signal) |
| **Live mechanics instrument** | **capped-live** on the real venue; + a paper-trading *smoke* pre-flight | real-traffic **shadow** (output logged, not served) | live A/B + feedback capture |
| **Dwell / sample floor** | **≥N real-fill trading days**, pre-registered, immutable downward | **≥N held-out items** for a binding verdict | required sample from the MDE, run to a fixed duration |
| **Promotion rule** | AND( dwell≥N , backtest margin BEATS/TIES , no DISQUALIFY ) | AND( held-out margin ≥ θ , n≥floor , non-vacuous , no guardrail trip ) | AND( stat-sig effect , no SRM , no guardrail regression , past novelty decay ) |
| **Verdict shape** | enum `CLEAN/CONCERN/DISQUALIFY` + enum `BEATS/TIES/LOSES` | margin → boolean rule; report effect + guardrails together | significance + guardrail panel; one primary metric declared up front |
| **Kill trigger** | any `DISQUALIFY` day OR drawdown trip → instant stop | vacuous-change assert fails; contamination assert fails loud | SRM detected; guardrail (latency/errors) regresses |
| **Rollback** | revert the strategy ref to the prior version; next cycle rebalances | evict the bad model/adapter; route never blends, always switches | flip the flag back to champion; the variant code stays, resurrectable |
| **Human vs auto** | promotion auto on conclusive proof; **revert auto**; irreversible/real-money-root changes human-gated | promotion auto by rule; base-model swap human | promotion human on a rate limit; pipeline auto-*proposes* only |

## Where the vocabulary maps

| Generic term | Strategy | Model | Product |
|---|---|---|---|
| champion | deployed strategy ref | active model / serving path | champion variant |
| challenger | capped-live candidate | staged model / adapter | challenger variant |
| promotion gate | promotion contract (AND of 3) | promote rule (margin + floors) | approval of the experiment readout |
| guardrail metric | daily verdict + drawdown breaker | non-vacuous + contamination guards | latency / error / SRM checks |
| dwell / power | real-fill dwell N (clock) | held-out n floor | required sample, fixed duration |
| held-out set | archived backtest window | disjoint held-out corpus | (the live control arm) |
| shadow | sim-and-log | real-traffic shadow | a quarantined / unlisted variant |
| kill switch | DISQUALIFY / drawdown breaker | vacuous/contamination assert | SRM / guardrail breaker |
| rollback | revert ref + normal rebalance | evict model/adapter | flip flag back |

## Do the ideas translate? Three transplants worth making

These are the strongest mechanics from one domain that the others often lack.

1. **Strategy → all: the "freeze-replay" test for *what is even under the gate*.**
   *"Would replaying this on frozen inputs give the same result? What you freeze and vary = system (gate it). What you hold identical = data (CRUD it)."* The Model case half-applies this already (routing *labels* are data the model shouldn't see at serve; the *router* is system). Many Product setups have no explicit line — feedback **content** is data (screened, never gated), but the **variant registry** and the **experiment code** are system. Drawing this line stops two opposite errors: gating routine data behind a heavy human approval (too slow), and letting a code change reach the consequence ungated (unsafe).

2. **Strategy → Model & Product: the AND-of-conjuncts gate with an *immutable-downward dwell*, plus enum verdicts.**
   A single score is gameable and noisy. The Strategy gate is `dwell ∧ margin ∧ clean-reasoning`, and the dwell is a **clock immune to persuasion** — good reasoning earns a clean verdict, not fewer days. A Model gate often has a margin rule and an n-floor but no time/clock guard and reports a raw float; a Product gate often lacks a pre-registered sample floor or significance rule. Both should add: (a) a pre-registered minimum sample/time floor that can only be *extended*, and (b) collapse the decision to an enum so the auto-path never compares free text or a bare float (Goodhart-resistant).

3. **Model → Strategy & Product: held-out discipline + contamination guards as a *hard, loud* gate.**
   The Model domain gets burned by in-sample memorization (a high in-sample score collapsing on a truly disjoint held-out set) and by **vacuous changes** (an adapter that's all zeros, *passing* eval by tying). The fix — assert the change is materially non-vacuous, and fail **loud** if the held-out set is contaminated — generalizes. A Strategy backtest must guard look-ahead (capture the archive *at ingest time*, eagerly, never reconstruct post-hoc). A Product pipeline should refuse to act on a treatment whose feedback can't be attributed to it (SRM-style: did the variant actually serve to the users whose feedback you're crediting?).

### The asymmetry is the unifying principle

All three converge on the same safety shape, stated most sharply by the Strategy case:

> **Promotion (toward risk) is gated, slow, pre-registered, and may require sign-off. Reversion (toward known-good) is unconditional, instant, and automatic.** The kill path never waits on the dwell.

The Product case expresses it as quarantine-before-promote + cheap-retire; the Model case as grow-the-pool-freely-but-evict-on-wrong-answer. Name this asymmetry explicitly in every champion/challenger system you build.

## Further reading

- **Trustworthy online experiments** — Kohavi, Tang & Xu, *Trustworthy Online Controlled Experiments* (2020); Microsoft ExP, *Patterns of Trustworthy Experimentation*; *Diagnosing Sample Ratio Mismatch in A/B Testing*.
- **Variance reduction** — Deng, Xu, Kohavi & Walker, *CUPED* (WSDM 2013).
- **Sequential / always-valid testing** — Larsen et al., *Statistical Challenges in Online Controlled Experiments* (The American Statistician, 2023); Johari et al. on always-valid p-values.
- **Backtest overfitting** — Bailey & López de Prado, *The Probability of Backtest Overfitting* and *Pseudo-Mathematics and Financial Charlatanism* (AMS Notices, 2014) — best-of-N, Minimum Backtest Length, Deflated Sharpe Ratio.
- **Offline-eval leakage** — Ji et al., *A Critical Study on Data Leakage in Recommender System Offline Evaluation* (ACM TOIS, 2023).
- **Automated canary analysis** — Netflix/Google **Kayenta** (Spinnaker) for the shadow→canary→ramp rollout shape.
