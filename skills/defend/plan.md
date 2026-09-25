# DefendPlan — wayfinder result → build dispatch (counsel)

Fires when the Director (qwen wayfinder) has a plan ready and the User is about
to release it to the Driver for build. The gate sits **between user and
Director** — its verdict reaches the user directly.

## Input to counsel (pipe all of it)

1. The wayfinder result (plan, objectives, chosen strategy).
2. Supporting evidence the plan rests on (data, links, prior results) — not
   just claims that evidence exists.
3. Mission/axis context: which UM-axes this serves, what was rejected and why.

## Mandatory lenses

- **Evidence gaps** — which load-bearing claim has no evidence behind it?
- **Unprototyped assumptions** — which assumption should be a prototype before
  a sprint is spent on it?
- **Strategy alternatives** — a materially different strategy the plan never
  considered?
- **Cost of wrong** — if the core premise is wrong, what is already spent?
- **Reversibility** — which early commits make later phases un-reversible?

## Attack shapes (expected)

- "No — prototype A before building."
- "Get more evidence for B; here is the cheapest experiment that settles it."
- "Did you consider strategy C? It trades X for Y."

## Verdict routing

`CLEAR | ATTACKS` → user. On ATTACKS the Director iterates with the user and
re-submits; re-runs are allowed but each re-run is another counsel call — converge
or escalate to a human decision, don't loop.
