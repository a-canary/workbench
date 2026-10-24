---
name: capacity
description: Shared-capacity ledger + advisory router for directors racing the same provider quotas (Claude window, MiniMax cap, vast wallet) — recovers hidden caps from organic 429s and says run/park/escalate per dispatch. ADVISORY + FAIL-OPEN; never blocks a dispatch. Use via the director `capacity` binding or the CLI directly.
---

# capacity

Cross-process capacity memory. N directors each see only their own traffic;
this skill pools every outcome in one sqlite ledger and answers "is there
headroom on this provider for this lane, right now?"

**Red line: advisory + fail-open.** Any internal error → the CLI prints
`{"action":"run","fail_open":true}` and exits 0. If you find a code path where
a capacity failure blocks a dispatch, that is a bug — file it, don't work
around it.

## CLI

```sh
bun ~/.claude/skills/capacity/capacity.ts record --provider claude --tokens 12000 --status ok|429
bun ~/.claude/skills/capacity/capacity.ts headroom [--provider claude]
bun ~/.claude/skills/capacity/capacity.ts route --provider claude --lane critical|research|standard [--ctx N] [--parked-min N]
bun ~/.claude/skills/capacity/capacity.ts stats
```

DB: `$CAPACITY_DB`, default `~/vault/capacity.db` (bun:sqlite, WAL, one table
`outcomes(ts, provider, tokens, status, meta)`). Directors on the same box
share it by default — that sharing IS the point.

## Verdict contract

`route` prints one JSON object:

```json
{"provider":"claude","action":"run|park|escalate","reason":"…",
 "headroom":{"frac":0.4,"capLB":2400000,"windowHours":5,"blocked":false},
 "vast_stop":false,"fail_open":false}
```

- `run` — dispatch normally.
- `park` — re-queue; research lane parked ≥30 min also sets `vast_stop:true`
  (signal only — a warm-pool reconciler may act on it; this skill never
  touches leases).
- `escalate` — critical lane only (critical never parks): dispatch anyway on
  the best alternative provider and note the constraint.

## Estimator (P-EST)

Passive only — never probes. From organic `(ts, tokens, status)` rows:
spend-at-block = cap lower-bound (trailing-7d max, so silent plan downgrades
age out); window length = mode of refill-anchor deltas (first success after a
429 lands on a true window boundary); reset gaps >12h classify as weekly-cap
blocks and feed `weeklyCapLB` separately. A provider that has
never 429'd stays `known:false` → always `run`.

## Director binding

```
capacity: capacity        # in AGENTS.md `## Director bindings`; omit or `none` to skip
```

Bound directors call `route` before dispatch (lane from the task's
criticality tier), `record` after every provider response, and emit
`capacity.parked` / `capacity.failopen` events to the bus. See
`skills/director/SKILL.md` § budget gate.

## Validation

`validate.ts` is the hermetic arcsim harness (5 rounds: nominal, plan
downgrade, outage, weekly-cap burst, cold start). `capacity.test.ts` holds the
port-parity gate (≥90% cap recovery vs the seed-42 reference on both provider
truths). Scorecard: `VALIDATION.md` after a round-5 green run.
