# Move block

The atom of a wargame. Every move in a `wargames/<mission>.md` file is one of
these. It encodes the agentic loop — **action → reaction → counteraction** — so
an executor knows not just what to do, but what to watch for and what to do when
it goes wrong.

```markdown
## Move N — <what this move does>

**Action:** the concrete step to execute.

**Expected observation:**
- ✅ Worked: exactly what you should see if it succeeded.
- ❌ Didn't: exactly what you'd see if it failed.

**Most-likely failure:** the single most probable way this move breaks.
- *Cause:* why it happens.
- *Signals:* the error text / symptom that tells you it's this failure.
- *Countermove:* the specific recovery step.

**Forks:**
- If you observe `<trigger X>` → go to Move N.a (route A).
- Else if `<trigger Y>` → go to Move N.b (route B).
- Else → continue to Move N+1.

**Downstream consequences** (2nd/3rd-order, to chosen depth):
- If this move's countermove fires, then <consequence>, which forces <next consideration>.
- Stop-depth: <why we don't simulate further here>.
```

## Guidance

- **Be concrete on signals.** "It might fail" is useless; the exact error string
  or observable symptom is what lets a cheaper model self-diagnose.
- **One primary failure per move.** List the *most-likely* one fully. Secondary
  failures only if genuinely plausible — don't pad.
- **Forks need triggers, not vibes.** A fork the executor can't detect from
  observation is not a fork.
- **Depth is a decision.** Simulate 2nd/3rd/4th-order consequences where the risk
  is real; stop early where it isn't, and say you stopped. The human sets depth.
- **Reference, don't inline, shared context.** Point at `assumptions.md` /
  `ledger.md` rather than repeating variables in every move.

## Worked micro-example

```markdown
## Move 3 — Run the DB migration against staging

**Action:** `npm run migrate:staging`.

**Expected observation:**
- ✅ Worked: "Applied 3 migrations" and `schema_migrations` shows the new version.
- ❌ Didn't: process exits non-zero, or table already exists error.

**Most-likely failure:** migration already partially applied from an aborted run.
- *Cause:* prior run died mid-transaction on a non-transactional DDL.
- *Signals:* `relation "orders_v2" already exists`.
- *Countermove:* inspect `schema_migrations`, manually mark the applied step,
  re-run from the next.

**Forks:**
- If `already exists` on a table you can confirm is complete → mark + skip it.
- If `already exists` on a *partial* table → drop it, re-run the full migration.
- Else (clean apply) → continue to Move 4.

**Downstream consequences:**
- A manual mark that's wrong desyncs staging from prod schema → Move 6
  (prod migration) will diverge. Stop-depth: prod migration is its own move.
```
