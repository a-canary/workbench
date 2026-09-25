# Market Analysis Cache

## Cache location

`.arc/market/<slug>.md` — one file per analyzed space.

Slug = kebab-case of the space name (e.g., `cli-compact-tools` for "CLI compact tools").

## Cache schema

```markdown
---
market-comparison: v1
space: <one-line problem>
audience: <who>
output_type: repo | blog | video | product | feature | social
created: <ISO date>
next_due: <ISO date or null>
refresh_trigger: manual | cron | publish_event
beads_parent: <issue id>
---

## Neighbors (8)

| # | Name | URL | What it does | Signal | Notes |
|---|------|-----|--------------|--------|-------|
| 1 | ... | ... | ... | ... | ... |

## Rubric

| Axis | Industry bar (best) | Industry bar (avg) | Our bar | CLONE/DIFF | Evidence |
|------|-------------------|-------------------|---------|------------|----------|
| ... | ... | ... | ... | ... | ... |

## Clone vs Differentiate

### CLONE axes (must match industry)
- <axis> — why users expect it, how we'll match

### DIFFERENTIATE axes (our wedge)
- <axis> — mechanism, evidence we can beat best

## Gate results

### ideate→develop
- **Result:** PASS | FAIL
- **Date:** <ISO>
- **Gaps exploited:** <list>
- **DefendPlan attacks:** <list or none>

### develop→publish
- **Result:** PASS | FAIL | STALE
- **Date:** <ISO>
- **Scores:** <per-axis>
- **Regressions:** <list or none>
- **DefendDeploy attacks:** <list or none>

## History

| Date | Event | Trigger |
|------|-------|---------|
| ... | ... | ... |
```

## Beads integration

The parent issue tracks staleness:

| Beads label | Meaning |
|-------------|---------|
| `market-comparison:map` | This is a market map |
| `market-comparison:stale` | next_due passed or new neighbor detected |

### State machine

```
open → in_progress → done → (stale | re-charted → open)
```

- `open`: Charting phase (tickets 1–5 active)
- `in_progress`: Working a ticket
- `done`: Analysis current, gates passed
- `stale`: Needs refresh before next gate

### Queries

```bash
# Find all market maps
bd query "label:market-comparison:map"

# Find stale maps
bd query "label:market-comparison:stale"

# Find maps due for refresh (manual check)
bd query "label:market-comparison:map state:done"
```

### Refresh triggers

1. **Manual:** User runs market-comparison on the same space again → prompts refresh
2. **Cron:** Weekly job queries `label:market-comparison:map state:done`, checks `next_due`, flips to stale if overdue
3. **Publish event:** Before DefendDeploy, check if map is stale → require refresh or fail gate

### Cron job (example)

```bash
# Weekly: mark stale any done maps past next_due
bd query "label:market-comparison:map state:done" --format json | \
  jq -r '.[] | select(.next_due < now) | .id' | \
  xargs -I{} bd update {} --add-label market-comparison:stale
```

## Defend wiring

The cached analysis feeds defend gates:

- **DefendPlan**: Read `.arc/market/<slug>.md`. Attacker must address:
  - DIFFERENTIATE claims have mechanisms
  - ≥2 DIFFERENTIATE gaps exist
  - CLONE axes cover industry expectations

- **DefendDeploy**: Read the develop→publish section. Attacker must address:
  - All axes meet OUR bar
  - No regression vs ideate→develop plan
  - Scores match evidence (not just intent)

If map is stale → DefendDeploy fails closed (no stale analysis gates release).
