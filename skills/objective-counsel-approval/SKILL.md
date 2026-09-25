---
name: objective-counsel-approval
description: 'Adjudicate ONE planner-proposed objective per run via a /counsel panel against ~/vault/missions.md, writing exactly one verdict: revise | approve | reject | human-gate. Hard-throttled to 1/hour. Use for the hourly proposal-adjudication cron, or when the user says "run objective counsel", "adjudicate proposals", or "counsel-approve an objective".'
---

# Objective-Counsel-Approval

The **/counsel substitute for the user** on the objective-approval surface.
The planner auto-proposes objectives (blue `inferred` cards); this skill lets a
5-expert panel adjudicate ONE of them per hour in the user's place — EXCEPT
where the proposal touches a human-gated class, which it can only *route* to the
user, never clear (UM-0300: agents never self-approve mission expansion; counsel
is the named substitute, gate-removal/spend/publish/delete/account are the
carve-out).

This is a CAM adaptor: proposals are the collected evidence, the throttle is the
clock, counsel is the single decision writer. One verdict row per run, append-only.

## 0. Throttle — 1 counsel/hour, one proposal

Counsel is 5 sub-sessions × 2 rounds = expensive. Never run two per hour, never
adjudicate two proposals per run ([[one-repo-at-a-time]]).

Freshness gate FIRST — has a counsel verdict landed in the last 60 min?

```
select id, created_at from feedback
  where source='objective-counsel'
  and id like 'oca-%'
  and (CASE WHEN typeof(created_at)='integer'
        THEN datetime(created_at,'unixepoch')
        ELSE replace(created_at,' ','T') END) >= '<now minus 60 min, ISO>'
```

- No `sqlite3` binary on this host — run every query via
  `PATH=$HOME/.bun/bin:$PATH bun -e '…bun:sqlite…'` against `~/vault/ledger.db`.
  Exit 127 is a tooling error, NOT an empty gate — never proceed on it.
- `created_at` mixes epoch ints and space/ISO strings — always normalize with the
  `CASE WHEN typeof…='integer'` expression ([[ledger-created-at-formats]]); a raw
  string compare silently drops space-format rows and lets a fresh run double-fire.
- A row exists → a counsel already ran this hour. Say so, log NOTHING, end.

Cost discipline is the point of the throttle: without it the panel fans out on
every proposal every tick and burns the window.

## 1. Gather + prioritize the proposal pool

Collect every OPEN proposal — the not-yet-approved `inferred` objectives the
planner has surfaced. Two sources, union them:

- **PRD-body proposals** — objectives in a `\`\`\`objectives\`\`\`` fence inside a
  pending PRD's `body_md` (`pendingObjectiveProposals`, see
  `src/mission-objectives.ts`). These are the planner's Slice-B emissions.
- **CHOICES fence rows** flagged `provenance: inferred` not yet applied to the
  repo's live objectives.

**One proposal = one objective, NOT one PRD.** A single PRD can bundle several
objectives across different axes with different gate-classes — e.g. the
cli-proxy PRD carried a UM-0400 counsel-eligible objective alongside a UM-0700
publish-gated one. Adjudicating the PRD as one unit lets a gated objective ride
along on an eligible verdict — the exact trust leak §2 exists to stop. So
**split every multi-objective PRD into per-objective proposals** at gather time;
each objective is ranked, gate-classed (§2), and adjudicated independently. A
proposal's axis tag is the `## Mission:`/`## Axis:` heading nearest ITS fence,
not the PRD's.

Prioritize — adjudicate the single highest-value one. Rank by, in order:

1. **Axis rank** (`~/vault/missions.md` "## Ranking") of the axis the objective
   is tagged with — hygiene(1) > use-value(2) > … > sovereignty. Higher axis first.
2. **Veto proximity** — a proposal advancing a `[veto]` axis (Epistemic/Societal/
   Security) outranks a same-rank scored one.
3. **Age** — oldest OPEN proposal breaks ties (starvation guard; a proposal that
   never wins is a starved proposal — surface it in the run log if it's been
   skipped ≥N runs rather than let it rot silently).

Exactly one proposal proceeds. Log the runners-up (id + why-not-picked) in the
verdict row so the pool is auditable — never a partial write.

Empty pool → say "no OPEN proposals", log nothing, end.

## 2. Classify the gate — CAN counsel decide this at all?

Before spending the panel, run the **gate-class check**. Counsel may adjudicate
ONLY proposals that touch no human-gated class. Human-gated classes (default to
human-gated when UNSURE — the classifier is conservative by design, an under-label
is the one failure mode that leaks the whole trust model):

- **gate-removal** — the objective removes/weakens a human gate or check-in
  (UM-0300: "never gate-removal without a named substitute").
- **spend** — commits money / GPU-lease / paid API beyond a set cap.
- **publish** — posts/sends anything to an external service or audience.
- **delete** — destroys data, repos, or accounts.
- **account** — creates/modifies a credential, mailbox, or identity.

Any class matches → **verdict = `human-gate`** immediately. Do NOT run counsel;
write the verdict routing it to the user with the matched class named. This is the
UM-0300 carve-out: counsel is barred, the user is the only approver.

No class matches → the proposal is counsel-eligible; proceed to §3.

## 3. Run counsel over the proposal

Invoke [/counsel](../counsel/SKILL.md) on the single proposal. The panel's brief
is scoped to two review lenses. Both lenses are always run — neither may be
skipped. Within the all-axis lens, every axis gets an explicit verdict, and
`n/a` is a legitimate verdict: most axes are n/a to most objectives. "Required"
means no axis is silently dropped, never that every axis must fire.

- **General review** — is the objective well-formed? Direct metric of the value
  (or proxy with the Goodhart gap named)? Recorder + cadence specified? Gate
  evalGate-parseable? Baseline recordable? (apply-mission §3-4 contract.)
- **All-axis review** — walk EVERY axis in `~/vault/missions.md` (the UM-xxxx
  missions AND the ranked principles hygiene/use-value), not just the axis the
  proposal is tagged with. For each: does this objective *advance*, *conflict
  with*, or is it *n/a* to that axis? A proposal that scores well on its own axis
  but conflicts with a higher-ranked axis (or trips a veto) fails — rank binds,
  vetoes bind by kind at any rank.

The 5 experts (skeptic/pragmatist/strategist/historian/devil-advocate) each
research (ke:recall the axis history, read the repo CHOICES/README) and argue
across 2 rounds, then synthesize toward ONE verdict — not an academic report.

## 4. Write exactly one verdict

The panel synthesis maps to exactly one of four actions:

- **approve** — well-formed, advances its axis, conflicts with no higher axis,
  trips no veto. Counsel clears it in the user's place. Landing this = the same
  apply-on-approve path a user approval takes (CHOICES.md branch+PR, Lane-2), but
  the approver of record is `objective-counsel`, and the verdict row carries the
  panel's consensus count (e.g. 5/5) as the evidence.
- **revise** — the value is right but the objective is malformed (proxy without a
  named confirmation, no recorder, un-parseable gate, wrong phase order). Verdict
  carries **notes**: the specific fixes the planner must make. Routes back to the
  planner as a fresh proposal, NOT to the user.
- **reject** — the objective doesn't advance its axis, duplicates a live one, or
  conflicts with a higher-ranked axis / trips a veto. Verdict names the axis
  conflict. The proposal is closed, not re-queued.
- **human-gate** — reached here only if §3 surfaced a gated class §2 missed (the
  panel is the audit on the classifier). Route to the user, name the class, do NOT
  clear.

Write ONE feedback row, append-only:

```
id:        oca-<repo-slug>-<goalSlug>-<epoch>
source:    objective-counsel        (NEVER 'direct' — 'direct'=trusted mints junk;
                                      see [[auto-oversight-source]])
project:   <repo>
state:     OPEN for revise/human-gate (action required) | LOG for approve/reject
           (audit trail, [[feedback-log-sink]])
body_md:   verdict + one-line rationale + panel consensus (N/5) + runners-up +
           for revise: the fix notes; for reject/human-gate: the axis/class named
```

A verdict is a measurement (UM-0500): it cites the panel consensus and the axis
walk, never a fabricated score. No panel ran (human-gate short-circuit) → say so;
don't invent a vote count.

## 5. Schedule (one-time, idempotent)

Cron the hourly tick via `claude -p` (see [[schedule-hygiene]]). The `*/60`
cadence is the outer clock; the §0 freshness gate is the inner interlock so a
manual run and the cron never double-fire in the same hour. Low-effort model for
the gather/prioritize/classify legs; counsel itself dictates its own sub-session
models.

## Judging done

One run adjudicates exactly one proposal, writes exactly one verdict row of the
four kinds, respects the 1/hour throttle, and never lets counsel clear a
human-gated proposal. A run that logged two verdicts, ran counsel on a gated
class, or wrote source='direct' is broken — redo it.
