# Vector-field routing — locked spec

Approved 2026-09-17 with comments. Supersedes the phase-1 shadow design in
`auto-vec.ts`. Plain language is normative; numbers in §Config are the approved
values.

## Intent

Class labels are too coarse — two turns in the same class can need different
models. The vector field asks instead: *for turns that look like this one, which
model has actually been good?*

It is a **local** bandit layered on the existing **global** per-class one. The
class partition is replaced by a similarity partition computed per request.

## Retrieval

1. Embed the mission + the current ask. Trailing history is excluded.
   *Measured:* this is not the limiting factor. The store holds 1669 rows but
   only **203 distinct embeddings** — 95.6% exact duplicates — because the
   *input text* repeats (one 26-character prompt served 57×). Text-hash join:
   45 distinct texts over 222 sampled rows.
2. Find nearest stored turns **per candidate arm**, not globally: 16 neighbours
   each, however distant.
   *Why:* a global top-50 is always won by whichever two arms carry most
   traffic (93.7%), so the other ~50 arms are never retrieved. On the current
   store, per-arm retrieval takes neighbourhood arm diversity from **2 → 15**
   with no extra I/O — one pass, bucketed by arm.
3. Row signals **fade with distance**. Weight is `1 / (distance + 0.05)`, not
   the current `sim²`.
   *Measured dynamic range over 2165 observed neighbour sims:* `sim²` = 4.3×,
   floored inverse-distance = 11.3×. The **unbounded** `1/distance` is 517,000×
   and is rejected: duplicates sit at `sim = 1.000` exactly, so one repeated row
   would determine the whole posterior.
4. **Duplicate vectors may not contribute duplicate confidence.** Total weight
   per unique embedding is capped, so `nEff` measures evidence rather than
   prompt popularity.
   *Why:* today 50 copies of one prompt give `nEff = 50` and pass the density
   gate on a single observation. That is why 78.6% of shadow rows are `sharp`
   while the neighbourhood spans only 2 arms.

## Scoring

5. Each arm's local track record is a success rate over its own neighbours.
6. The global per-class record is a **light starting hint only** — weighted so
   that 16 real neighbours can override it.
   `priorWeight` drops **3 → 0.013**. This is the single bug the refactor exists
   to fix: at 3, the prior contributes ~3888 pseudo-observations against a
   local maximum of ~50, so `pickVec` has returned non-null **0 times in 1669
   rows**. Under per-arm-16 (local mass ~14) the ceiling for `mean ≥ 0.9` is
   `priorWeight ≤ 0.0152`.
7. **Two thresholds.** Below a floor an arm is never selected — pick another, or
   fail the turn. Above a ceiling it runs without a judge or competitor on 90% of
   traffic. (The ceiling half already exists as `EXPLOIT_GATE = 0.90` /
   `EXPLOIT_SHARE = 0.9`; the floor does not.)
8. Selection is a weighted random draw, not argmax: quality estimate, discounted
   by what the arm costs.
9. **Quality and cost stay separate factors.** Cost must not enter the evidence
   denominator — an expensive arm is not thereby a less *correct* arm.
10. Cost means money, latency and warm-up together: provider price, observed
    response time, and the penalty for a cold model needing to load or a cache
    miss. (`cacheFactor` and `swapUsd` already express the last one.)
11. **A new arm starts neutral on quality and pessimistic on cost** — worst
    observed, never zero. Zero cost makes an unmeasured arm win every draw and
    routes all traffic to the newest model. Same principle already adopted for
    local GGUF: *"swap pricing uses worst-observed `loadMsMax`"*, *"unmeasured
    arms must not be stamped with assumed prices."*
12. Only **quality** outcomes move the track record. Timeouts, outages and
    gateway errors go to a separate short-term cooldown. An arm that was down
    must not be remembered as an arm that was bad.

## Warmup

13. No warmup state machine. Warmup is implicit in accumulating records —
    **provided the explore branch emits a real pick.** Today it sets
    `would = null`, which in live routing falls back to the incumbent and
    therefore routes to the same two workhorses; a new region would accumulate
    rows only for arms already favored, and warm up biased. The eps branch must
    pick, weighted toward arms with little local evidence.
14. New regions inherit the global prior until local evidence accumulates.

## Data lifecycle

15. Record **every** turn, including failed, gated and exhausted ones. A store
    containing only successes cannot learn what to avoid. (Today `observe()`
    drops anything not `served`/`served-heal`: 94 exhausted, 386 gate-rejects
    and 145 serve-errors in the same window are invisible.)
16. Each row carries `ms` and `px` so latency and price can be predicted from
    the neighbourhood. This is a schema addition — `VecResult` is currently
    `{i, ts, arm, ok}`. Existing rows cannot be backfilled reliably: the only
    join key is `ts`, taken at observe time vs serve time.
17. **FIFO cap at 100,000 rows.** Oldest retire first.
    *Measured:* 154 MB resident, **62 ms/lookup** brute force at 384 dims.
    Median turn is 12,362 ms, so the scan is **0.5%** of turn time. No ANN
    dependency is needed at this cap. (500k would have been 768 MB / 299 ms.)
18. **Store the embedding dimension explicitly and validate on load.** It is
    currently *inferred* by `bin.byteLength / 4 / results.length`; `append()`
    writes the bin before the jsonl, so a crash between them desyncs the files,
    the inferred dim goes wrong, and every similarity silently becomes `NaN`
    with no error logged. Refuse to load on size mismatch.

## Rollout

19. **Cut over live**, not shadow-first, with heavy logging and close review
    cycles. Guardrails:
    - one config flag reverts to the incumbent instantly, no redeploy;
    - every routed turn logs the incumbent's pick, the vector pick, and the
      outcome, so a review cycle is a query and not an excavation;
    - the abstain causes are logged **separately** — done: `routeZone` returns
      `why: "ood" | "eps" | "inadequate"` on every ts path. (`inadequate`
      deliberately conflates under-evidenced with unhealthy-when-`ok`-is-supplied;
      the caller knows `ok` and can split it if it ever needs to.)
    - **the shadow must cross the same seam live will.** A shadow logger that
      re-implements the decision drifts from it silently, and then every rate it
      reports is fiction. This happened: `step()` carried its own
      `nb.sharp && roll >= eps` formula while `routeZone` passes `!nb.sharp` as
      *tie-mode*, so the shadow logged `would: null` on turns live would steer
      (17 of the first 30 uncensored prod lines). Fixed in 302be7b by making
      `step()` call `routeZone`; a guard test now pins `pickVec` to one
      definition and one call site. Corollary: **any pick rate quoted from shadow
      data before 302be7b is void**, including the 0.3% in Amendment 1.
      Shadow `would` stays an *upper bound* — it passes no `ok` predicate and no
      cost fn, because auto-vec has no view of backoff or the price map.
20. The comparison metric is **predicting the outcome**, not agreeing with the
    classifier. Agreement is not evidence of quality.

## Config (approved values)

| key | now | approved |
|---|---|---|
| `priorWeight` | 3 | **0.013** |
| neighbours | global top-50 | **per-arm top-16** |
| row weight | `sim²` | **`1/(dist+0.05)`** |
| duplicate weight | uncapped | **capped per unique vector** |
| row cap | none | **100,000 FIFO** |
| `dim` | inferred | **stored + validated** |
| `VecResult` | `{i,ts,arm,ok}` | **+ `ms`, `px`** |
| eps branch | returns null | **returns a pick** |
| `adequacyFloor` | 0.9 | **retune after priorWeight lands** |

## Out of scope

The gate/truncation fix (branch `fix/gate-truncation-and-dbread`), local GGUF
lifecycle, and price calibration.

## Known open risk

The shadow data cannot validate this design before cutover: 203 distinct vectors
and 2 arms carrying 93.7% of traffic. The log censor is gone (f81b3a6) and the
shadow now crosses the live seam (302be7b), so the open 1000-prompt window is the
first measurement that counts. Cutover still rests on the revert flag and the
review cadence, not on prior evidence — there isn't any.

---

# Amendment 1 — measured against the live store (1733 rows)

Replayed the shipped retrieval over the production vec store, joined 99.9% to
`auto-llm.log` by (arm, ts±2s).

## The tie band is the product, not a failure

`sharp` fires on 0.3% of turns (median `best` = 0.545). That is not the router
failing — on an easy turn the judge genuinely cannot separate two competent
arms, and the correct response is to let **cost** decide, not to abstain to
class TS. The aggregate saving lives almost entirely in that band. So `routeZone`
now routes on cost when quality ties, instead of abstaining.

`adequacyFloor` is the hard quality guard: no arm below it is ever eligible, at
any price. Inside the gate, cost rules.

## Cost must price time, or the ranking inverts

`cw` built from $/1M tokens alone sent **75% of turns to an arm backed by 8
rows** — cheapest per token, slowest per turn (96% of its turn cost is wall
time at the $0.50/min stall rate). Result: −67.9% money for **+57.9% time**.

`turnCostWeight` (auto-llm.ts) prices money + wall time over realized per-turn
medians, same `(med/total)^alpha` shape and `[0.25,4]` clamp as `costWeight`, so
there is still one cost model. Contract documented on `pickVec`.

## Declaring a tie is a claim about evidence

The dup cap erases row counts, so weight cannot distinguish "8 observations"
from "800". `ArmStat.k` (distinct backing turns) can. `pickVec(..., minArmK=3)`
bars under-evidenced arms from *winning a tie*; they stay eligible for
quality-led selection when `sharp` is true.

## Measured outcome, same 1733 turns

| cw basis | money | time | picks for the 8-row arm |
|---|---|---|---|
| $/1M tokens only, no evidence floor | −67.9% | **+57.9%** | 1297 (75%) |
| total cost (money+time), `minArmK=3` | **−25.8%** | +1.9% | 33 (1.9%) |

Winner is `deepseek-v4-flash` (491 → 1147 turns): 0.57× the dominant arm's
price, 16.3s vs 19.2s, and statistically indistinguishable from it on quality
(z=+1.90 vs +2.63). That is the free saving.

## Blocking prerequisite: the censor

The store retains **7.9% of the discriminative signal**. `observe()` accepts
only `mode ∈ {served, served-heal}`, so 421 of 457 non-approve rulings never
reach it (denied-retry 129, comment-overruled 103, corrected 92,
correction-failed 79, comment-delivered 18). Joined ruling rate inside the
store is 1.8% — indistinguishable from the `ok` field.

Across the *uncensored* log arms separate decisively: χ²=70.0 on 5 df (5%
critical 11.3, p<1e-12). MiniMax-M3 6.13% non-approve (z=−7.41) vs mimo-v2.5
14.97% (z=+2.63). And MiniMax-M3 — the best arm — is under-routed at 11.8% of
vec turns vs mimo's 52.3%.

Consequence for this design: with the censor in place, `adequacyFloor=0.9` is
not a real quality guard (every arm's mean is ≈0.98), so cost-first tie-breaking
is currently protected only by `minArmK`. **tt4 (uncensor `observe()`) is a
prerequisite for trusting the tie band, not a follow-up.**

## Numerical defect found and fixed

`priorWeight=0.013` with no pseudocount floor makes `betaSample` degenerate:
`gammaSample(0.013) ≈ rng()^77`, so draws land on exactly 1.0 for 87% of trials
with 40% exact ties. Measured `P(A>B)` = **0.300** for A=(36.7 wins, 0 losses)
vs B=(2.2 wins, 0 losses) — the better-evidenced arm *lost* 70% of the time.
Fix: `a0 = local + max(prior×priorWeight, 0.5)` (Jeffreys). Gives 0.836, zero
ties. `priorWeight` (shrinkage) and the pseudocount (numerical floor) are
different quantities and must stay decoupled.

## Still open after this amendment

- `ms`/`px` per row in `VecResult` (i43) — the sim used log-joined medians;
  per-row values would make cost prompt-conditioned instead of arm-level.
- `adequacyFloor` retune (5jb) — once tt4 lands, means drop from ≈0.98 to
  ≈0.85–0.94 and 0.9 becomes a real cut rather than a formality.

---

# Amendment 2 — pricing the hidden cost of unverified exploitation

Operator requirement: exploiting a model that returns an unverified response can
derail a whole session or cause material loss, so that risk must carry a very
high implicit cost even though it never appears on an invoice.

## Expressed as pessimism, not as a dollar figure

Inventing `riskUsd` would add a constant nobody can calibrate, and it would sit
in a cost axis where a few-cent price gap could still outbid it. The risk is a
statement about *evidence*, so it belongs on the quality axis: gate and rank on
the **Wilson lower bound** of the arm's success rate instead of its mean.

`wilsonLcb(a, b, z=1.64)` — one-sided 95%. Exploiting an arm whose failures were
never observed now costs exactly what the evidence says it might. `riskZ` is the
single hidden-cost knob: raise it to demand more verified evidence.

This **subsumes `minArmK`**, which was an arbitrary count threshold reaching for
the same protection. `k` is deleted from `ArmStat`; the bound does the work with
one fewer invented constant. Measured: 8 lucky rows bound at 0.770, a 100-row
arm at 0.974 — same protection, no count knob.

## The floor changed scale — this is a deployment footgun

`adequacyFloor: 0.9` was calibrated on means. On the bound it is unreachable:

| n (pseudo-obs) | p=1.00 | p=0.98 | p=0.95 | p=0.90 |
|---|---|---|---|---|
| 8 | 0.748 | 0.720 | 0.679 | 0.618 |
| 32 | 0.922 | 0.889 | 0.845 | 0.780 |
| 100 | 0.974 | 0.942 | 0.901 | 0.840 |
| 1000 | 0.997 | 0.971 | 0.937 | 0.883 |

A flawless arm needs n≥25 to clear 0.9; the realistic n≈33 arm at p=0.98 bounds
at 0.891. Note the last row: even with 1000 observations a 10%-failure arm never
clears 0.9. Default is therefore restated as **0.82** (admits a 98% arm from
n≈16, a 90% arm only from n≈60).

**The deployed config still says `adequacyFloor: 0.9` and `priorWeight: 3`.**
Config overrides the code default, so shipping this build without restating both
makes the router abstain on every turn. Both must change together.

## Not yet expressible: severity

The bound treats every failure as equal magnitude. If session-derailing failures
cost far more than a merely-unapproved response, the failure rate must be
severity-weighted (`deny` ≫ `heal` ≫ `corrected`). That needs the per-turn
`ruling`, which is censored out of the store — blocked on tt4, same as the
calibration of both floors above.
