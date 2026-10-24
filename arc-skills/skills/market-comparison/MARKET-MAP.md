# Wayfinder Ticket Template for Market Maps

When charting a market comparison map, use these ticket templates. Wire blocking edges in a second pass (issues need ids before they can reference each other).

## [1] Destination grilling (HITL)

**Type:** `wayfinder:grilling`

**Body:**
```markdown
## Question

What public-facing space are we entering? Name:
- The space (one sentence — what problem does the audience have?)
- The audience (specific person/group whose day changes)
- The value we aim to deliver (delta they experience when it works)
- The output type (repo | blog | video | product | feature | social)
- Why now (what triggered this analysis)

## Constraints

- Space must be one sentence, not a solution description
- Audience must be specific, not "everyone"
- Value must be a delta, not a feature list
```

**Resolution:** Space name + audience + value + output type locked.

## [2] Neighbor research ×8 (AFK)

**Type:** `wayfinder:research`

**Count:** Create 8 child tickets (one per neighbor).

**Body:**
```markdown
## Question

Find and profile one published solution in the space: <space>.

## Profile requirements

- Name + URL
- What it does (one sentence)
- Audience signal (stars, subs, downloads, revenue)
- Output type (repo | blog | video | product | feature | social)
- Strengths (2–3 axes where it excels)
- Weaknesses (2–3 axes where it falls short)

## Evidence

Read the actual artifact via `free-search fetch` — not the landing page. 
Score from the real thing.
```

**Resolution:** Neighbor profile appended to `.arc/market/<slug>.md` Neighbors section.

## [3] Rubric grilling (HITL)

**Type:** `wayfinder:grilling`

**Blockers:** All 8 neighbor profiles complete.

**Body:**
```markdown
## Question

Based on the 8 neighbor profiles, design the rubric:

1. **Axis selection:** What dimensions do neighbors actually judge on?
   - All 8 cover → mandatory CLONE axis
   - 5–7 cover → common CLONE axis
   - 2–4 cover → DIFFERENTIATE candidate
   - 0–1 cover → ignore (unless user argues)

2. **Bars:** For each axis, set:
   - Industry bar (best) — top neighbor's score
   - Industry bar (avg) — average across neighbors
   - Our bar — what we'll deliver

3. **CLONE vs DIFFERENTIATE:** Tag each axis.

## Constraints

- 5–8 axes total
- Each DIFFERENTIATE must have a mechanism (concrete, not "we'll be better")
- Evidence column must cite a source (neighbor name, benchmark, etc.)
```

**Resolution:** Rubric table written to `.arc/market/<slug>.md`.

## [4] Clone vs Differentiate grilling (HITL)

**Type:** `wayfinder:grilling`

**Blockers:** Rubric complete.

**Body:**
```markdown
## Question

For each axis, decide:
- **CLONE:** Match industry bar. How exactly will we match? (reference best neighbor's approach)
- **DIFFERENTIATE:** Beat best. What mechanism delivers our bar?

## Output

- CLONE axes: list with matching strategy
- DIFFERENTIATE axes: list with mechanism + evidence

## Gate check

- ≥2 DIFFERENTIATE axes with real mechanisms → ideate→develop PASS candidate
- <2 DIFFERENTIATE axes → ideate→develop FAIL (justify or pick different space)
```

**Resolution:** Clone/Differentiate table + gate decision written to cache.

## [5] ideate→develop gate (HITL)

**Type:** `wayfinder:task`

**Blockers:** [4] complete.

**Body:**
```markdown
## Question

Verify ideate→develop gate:

- [ ] ≥2 DIFFERENTIATE axes with mechanisms
- [ ] CLONE axes cover mandatory expectations
- [ ] DefendPlan has read the rubric + clone/diff plan

## Verdict

PASS → proceed to build phase
FAIL → go back to [4] or pick different space
```

**Resolution:** Gate verdict + DefendPlan reference recorded.

## [6] Re-score research (AFK)

**Type:** `wayfinder:research`

**Trigger:** After build phase completes.

**Body:**
```markdown
## Question

Score OUR artifact on the rubric from `.arc/market/<slug>.md`:

- Read the actual artifact (code, content, product)
- Score each axis 1–10 with evidence
- Flag any axis below OUR bar
- Flag any regression vs ideate→develop plan

## Evidence

Same standard as neighbor scoring: actual artifact, not intent.
```

**Resolution:** Re-score table written to cache.

## [7] develop→publish gate (HITL)

**Type:** `wayfinder:task`

**Blockers:** [6] complete.

**Body:**
```markdown
## Question

Verify develop→publish gate:

- [ ] All axes meet OUR bar
- [ ] No regression vs ideate→develop plan
- [ ] Cache is not stale
- [ ] DefendDeploy has read the re-score

## Verdict

PASS → ship
FAIL → fix or document deliberate deprioritization
STALE → refresh analysis first, then re-score
```

**Resolution:** Gate verdict + DefendDeploy reference recorded.
