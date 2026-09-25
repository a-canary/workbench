# DefendConviction — conviction change touching a held position → apply (counsel)

Fires when a nightly grade produces a conviction change that would **exit a
held slot or drop it below floor**, before that change is applied and traded by
the mechanical executor. Also fires on the scheduled full audit of every held
position's conviction. It does **not** fire on every tick — that is the
same-model multi-perspective layer. This gate sits between the grade module and
the apply step; its verdict blocks the weight change from being applied.

The point is cross-family independence: the model under attack (the one that
made the conviction call) must not be the attacker. Default attacker = counsel via
counsel, a different family than the Qwen/bonsai grade path.

## Input to counsel (pipe all of it)

1. The changed wind(s): name, thesis statement, conviction before → after,
   target weight before → after.
2. The evidence packet: **verified quotes** (verbatim, with sourceId + url) and
   the grade module's reasoning trace for each — not a claim that evidence exists.
3. Position status: is this wind currently a held slot? current weight? does this
   change exit it or drop it below floor?
4. Direction + magnitude: increase / decrease / exit; how large the move is.
5. History: recent conviction history for this wind (is this a flip-flop?) and any
   prior DefendConviction verdicts on it.

## Mandatory lenses

- **Affirmative disconfirmation** — for any DECREASE or EXIT: is there a verified
  primary-source fact that positively contradicts the thesis? "No new evidence",
  "low confidence", or "price fell" is NOT disconfirmation — it justifies a lower
  weight, not an exit. This is the direction-asymmetry rule; decreases are gated
  harder than increases.
- **Thesis vs price** — is the change driven by underlying facts or by price
  movement? A drawdown alone is not a thesis break.
- **Evidence provenance** — do the cited quotes actually exist in their sources and
  support the claim, or are they decontextualized / mis-sourced / paraphrased?
  (The mechanical verifyQuote bar already gates *existence*; this lens checks
  *interpretation*.)
- **Distinct-source depth** — does the change rest on data points from distinct
  primary sources, or one headline repeated / a single source?
- **Churn / hysteresis** — is this flip-flopping versus a genuine regime shift?
  Does it reverse a recent conviction without new distinct evidence?

## Attack shapes (expected)

- "Exit on <wind> is not disconfirmation — the only 'evidence' is an N% drawdown
  plus low confidence. Lower the weight; do not exit."
- "The cited quote from <source> does not support '<claim>' — it says <X>, which
  is about a different thing."
- "This reverses last week's increase on <wind> with no new distinct source —
  churn. Hold until a second independent source confirms."

## Verdict routing

`CLEAR | ATTACKS` → the apply step, surfaced **verbatim** (no summarizing away).
The consumer is a mechanical apply step with no human in the loop, so the verdict
must be operationally decisive. The attacker draws this line explicitly on every
attack it files:

- **Blocking** — refutes the *direction* of the change or its *evidence-soundness*
  (a mandatory-lens failure: no affirmative disconfirmation, price substituted for
  thesis, mis-sourced quote, single-source depth, churn). Any blocking attack →
  `ATTACKS` → do not apply.
- **Note** — a precision defect that does not change direction or evidence-
  soundness (sizing within the defensible band, phrasing, span overstatement).
  Reported under `CLEAR` as clear-with-notes; the apply step proceeds and logs the
  notes in the reason trace. Notes are never silent.

So: `CLEAR` = survives → apply (address notes if cheap); `ATTACKS` = at least one
blocking attack → do not apply pending more evidence or override (override = ledger
event: gate, attacks overridden, why). A CLEAR from counsel is still an untrusted
report — verify checkable claims against source before applying.
