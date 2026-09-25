# File templates

Scaffolds for the `.wargame/` tree. Fill the `<…>` and `(variable)` slots.
Create each file lazily — only when you have content for it.

## main.md — the index

```markdown
# Wargame — <repo / project name>

**Executor model:** <model that will run these, or "unspecified">
**Status:** <N> missions · <drafted / polished>

## Missions

| Mission | Brief | Wargame | Status |
|---------|-------|---------|--------|
| <name>  | [tasks/<name>.md](tasks/<name>.md) | [wargames/<name>.md](wargames/<name>.md) | draft / polished / blocked |

## Global abort conditions

Stop **all** execution if:
- <hard blocker, e.g. no access to prod credentials>
- <hard blocker>

## Open blockers
See [ledger.md](ledger.md). Unresolved assumptions in [assumptions.md](assumptions.md).
```

## success.md — the gate

What makes a wargame *complete*. Tune stringency to the stakes.

```markdown
# Success criteria

A wargame is complete when:
- Every move states its expected observation for both success and failure.
- Every move with a plausible failure carries a cause, signals, and a countermove.
- Every fork has an observable trigger.
- Consequences are simulated to a stated depth; stop-points are justified.
- The mission ends with explicit abort conditions.
- Every undefined input is a `(variable)` in the ledger — none guessed silently.
- An executor with no prior context could run it move-by-move without asking us.
```

## ledger.md — blockers & placeholders

```markdown
# Ledger

Anything blocked or needing human input. `(variable)` = executor must not guess.

## Blocked
- **<mission> / Move <N>:** <what's blocked and why>.
  - Inputs needed to unblock: `(what_kind_of_business)`, `(target_audience)`, …

## Placeholders in play
| Variable | Used in | Assumed value (if any) | Resolved? |
|----------|---------|------------------------|-----------|
| `(api_base_url)` | wargames/api.md Move 2 | none | ❌ |
```

## assumptions.md — unverified assumptions

```markdown
# Assumptions

Things recon could not resolve, taken as given. Verify before trusting.

- **<assumption>** — *basis:* <why we assumed it>. *Risk if wrong:* <impact>.
```

## tasks/<mission>.md — the mission brief

The input objective, phrased as a wargame order (not a plan request).

```markdown
# Mission: <name>

**Order:** You are NOT executing this mission — you are war-gaming it. A cheaper
executor model will run the brief below. Fight the mission on paper, move by
move, into `wargames/<name>.md`. Every move: expected observation (worked /
didn't), most-likely failure + cause + signals + countermove. Every fork: a
trigger. Flag unresolved inputs as `(variable)` in the ledger. End with abort
conditions.

## Brief
<what you're trying to do, in plain terms>

- **Context / current state:** <why now, what exists>
- **Audience / stakeholders:** (target_audience)
- **Desired outcome:** <the call-to-action / definition of done>
- **Constraints:** <framework, budget, must/must-not>
- **Verification:** when you believe you're done, <how to verify — exercise every
  path, open each page, run the suite, etc.> before reporting.
```
