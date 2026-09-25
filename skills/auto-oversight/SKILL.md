---
name: auto-oversight
description: One headless oversight pass over the NEXT mission in the cycle (trading → onenation → autonomy → local-models) — judge health/safety/alignment, resolve resolvable human-gates, take one small autonomy-improving action, log to webui /m/allmissions. Designed for a */15 cron on a low-effort model.
---

# auto-oversight

One mission per invocation. Rotate via the state file; never audit two missions
in one run ([[one-repo-at-a-time]]).

## 0. Rotate

Read `~/vault/oversight/state.json` (`{"next":"trading"}`; missing → `trading`).
That's THIS run's mission. Immediately write back the next in cycle
`trading → onenation → autonomy → local-models → trading` so a crashed run
never wedges the rotation.

**Compute the write-back from the value you just READ, never from the mission
you expected.** Two loops share this file; if the read value differs from your
prediction, another loop already rotated — your mission is the READ value, and
writing your precomputed "next" re-inserts a mission and double-audits it.
Best shape: one command that cats the file THEN writes read+1, so a stale
prediction can't leak in. Observed 2026-07-11: an interactive run expecting
`trading` read `onenation` (cron took trading minutes earlier) and wrote
`onenation` back — self-cancelling no-op caught only by hand.
**Parse the JSON tolerantly** — the file may contain whitespace
(`{"next": "onenation"}`); a rigid `grep '"next":"'` misses it and silently
falls back to `trading`. Use `grep -o '"next"[[:space:]]*:[[:space:]]*"[^"]*"'`
or a real JSON parser, and always echo the raw file + parsed mission together
so a mismatch is visible. Observed 2026-07-13: space-format file + rigid grep
nearly double-audited trading; caught only because raw cat printed alongside.
Write-back canonical form: no spaces (`{"next":"autonomy"}`).

**Freshness gate — skip duplicate audits.** After rotating, check the ledger
for a recent audit of this mission:

```
select id from feedback where source='auto-oversight'
  and id like 'ao-<mission-slug>-%'
  and replace(created_at,' ','T') >= <now minus 90 min ISO>
```

**Normalize the timestamp in SQL** — ledger `created_at` mixes formats
(`2026-07-16 09:40:18` space-separated and `2026-07-16T09:40:18Z` ISO). A
plain `created_at >= '<ISO>'` string compare silently excludes every
space-format row (`' '` sorts before `'T'`), so a fresh audit logged by the
other loop passes the gate unseen. Observed 2026-07-16: an `ao-autonomy-*`
row was invisible to the rigid compare (harmless at 150 min old; at <90 min
it would have double-audited). Always compare on
`replace(created_at,' ','T')`.

No `sqlite3` binary on this host — run the query (and the step-4 insert) via
`~/.bun/bin/bun -e '…bun:sqlite…'` against `~/vault/ledger.db` (`bun` needs
the full path or `PATH=$HOME/.bun/bin:$PATH`; cron env lacks it). Exit 127
here is a tooling error, NOT a clear gate — never skip the check.
**Open the db with `new (require("bun:sqlite").Database)(path)`, NEVER
`require("bun:sqlite").open(path)`** — the `.open` form exits 0 with ZERO
stdout (no `[]`, no error), so a fresh audit row is invisible and the gate
false-clears into a double-audit. Observed 2026-08-09. Any gate query that
prints nothing (not even `[]`) is a tooling error — rerun with the
`Database` constructor before treating the gate as clear.

A row exists → another oversight loop (cron vs interactive share the rotation)
already audited this mission; say so, log NOTHING, and end the run. Observed
2026-07-11: cron and an interactive loop double-audited trading (02:08 + 02:33)
and autonomy (04:10 + 04:29) — each duplicate is a full model run producing a
near-identical log row.

Mission → surfaces:
- **trading**: repo `~/repos/trading`, director `.arc/director/*`, crons (shadow rebalance, director-tick), open PRs, `/m/trading`
- **onenation**: TWO checkouts — deploy/prod `/home/aaron/projects/OneNation` AND director-dev `/home/aaron/repos/OneNation` (the 2h director cron plans from repos/; verify BOTH synced to origin/main or the director plans against stale code). Docker stack, QA journey cron log `.claude/qa-journey-cron.log`, deploy-drift cron `~/vault/onenation/deploy-drift.log`, open PRs, `/m/onenation`
- **autonomy**: repos `~/repos/arc-agents`, `~/repos/arc-webui` (GitHub remote is `a-canary/webui`, NOT `a-canary/arc-webui` — the latter 404s every `gh pr list`), `~/repos/arc-skills`; feedback drain cron; webui :8080 up; open PRs
- **local-models**: `~/repos/starlight-slm` (symlink → /mnt/Storage1; unmounted = parked, say so and move on)

## 0.5. Backstop parked-actions

Run the **parked-action backstop** for THIS run's mission (the `next` value
READ in step 0). This is the receipt-verification clause of the rotation:
when a prior oversight pass parked an action for another mission's director
(`kind=parked-action`, `project=allmissions`, `source=auto-oversight`,
`state=OPEN`), the target mission's director tick is supposed to dispatch it
and close the row with a receipt (a `kind=note` event tagged `receipt:
<dispatched-issue-id>`). This pass re-checks that the loop actually ran.

```
npx tsx ~/repos/trading/tools/oversight-backstop.ts report <mission>
# mission == the `next` value READ in step 0 (NOT what you expected)
# MUST be tsx, never bun — the tool ends in `runCliIfMain(module, …)` (repo
# CJS convention) and bun dies "ReferenceError: module is not defined";
# that's a tooling error, not a clear gate — rerun with npx tsx.
# binary lives in the trading repo (PR #179) — verify `gh pr view 179 --repo
# a-canary/Trading --json state,mergedAt` returns merged before relying on
# it; exit 127 here is a tooling error, NOT a clear gate — log it and end.
```

Tool prints a `BackstopReport` JSON object — read it and note the
`agedFlaggedIds[]` (OPEN rows older than one full rotation ≈ 6h, a director
missed them) and `missingReceiptIds[]` (CLOSED rows in the last 7 days with
no receipt event — director dispatched but did not record the receipt). Both
arrays are typically empty; surface them in the step-4 /m/allmissions log row.
Pure helper available too — `renderLogLine(report)` from the same module
formats a one-line summary if you don't want to walk the JSON yourself.

**Why this step exists.** Before this step, the backstop ran only if a future
oversight pass remembered to call it — and the receipt-verification clause was
never wired to the /m/allmissions log row. Parked-action rows piled up without
the loop ever confirming whether they were consumed. This step makes the
verification automatic on every rotation, matching the `LOG` clause in step 4
(operator directive 2026-07-12: routine audit rows are `LOG`, not `OPEN`,
unless they demand action).

Genuine human-gate parked rows stay `OPEN` by design (parked-item-handoff
US #8) — do NOT auto-close them on the basis of being `stale`. Stale +
`OPEN` = re-notice in the log row, not a resolution.

## 1. Judge (explore + explain, briefly)

For the mission answer each: **active?** (recent commits/ticks/cron fires) ·
**proving hypothesis?** (what evidence moved) · **high value?** ·
**safe?** (guardrails held) · **efficient?** (no waste/runaways) ·
**hygiene?** (stale branches/worktrees/locks/logs) ·
**aligned to mission + objectives?** (CHOICES/M-00xx) ·
**reflected in webui?** (does /m/<mission> show its real state).
Read facts from tool output; verify before alarming (recency-gate — never
re-flag what's already fixed).

## 2. Resolve human-gates

Any PR/deploy/dispatch sitting in a holding pattern: **hard-merge PRs that meet the merge gate and
deploy to their test/prod surface — never leave holding**. Standing order (Aaron
2026-07-10, [[hard-merge-standing-permission]]): the ONLY human go/no-go gate
is an **Objective or scope delta** (CHOICES-level, mission redefinition,
spend). Merge gate: CI green + independent reviewer where doctrine requires;
re-poll mergeStateStatus at merge time. **BEFORE merging ANY PR, grep the
ledger for an OPEN gate row citing it**
(`select id from feedback where state='OPEN' and body_md like '%PR #<n>%'`) —
a prior pass may have operator-gated it as a scope delta; an OPEN GATE row
overrides CLEAN/MERGEABLE. Observed 2026-08-09: PR #12 (starlight-slm) was
hard-merged despite gate row ao-local-models-gate-wm6us8 and 4 rounds of
attached hold-evidence; merge had to be reverted on origin/main. **Merge multiple green PRs one at a
time, not in a check-then-merge shell loop**: each merge transiently flips
sibling PRs' mergeStateStatus to UNKNOWN, so a chained `grep -q CLEAN &&
merge` loop aborts silently after the first merge (observed 2026-07-13:
arc-agents #358 merged, #357/#356/#348 skipped though CLEAN on re-poll).
Docker: own-stack only, obey the
shared-resource discipline rule in AGENTS.md. Gates you cannot resolve
(sudo, secrets, scope deltas): make sure they're visible on the webui —
an OPEN ledger feedback row renders on /m/<mission> (the attention axis).
NOTE: /approvals is a DIFFERENT queue (PRD approvals); feedback rows never
appear there. Verify visibility against /m/<mission>, not /approvals — a
zero-hit grep of /approvals is normal, NOT a webui gap (observed
2026-07-14). Then leave them.

**Reconcile ledger vs closed PRs.** A review-state ledger row whose PR (or
worker branch's PR) was closed unmerged by a deliberate verdict (YAGNI,
superseded, duplicate) is stale — the human decision already landed. Cancel
the row with an event citing the verdict; never leave it haunting the queue
(recurred 2026-07-13: onenation #172/#173 rows sat in review after close).
Ledger event table is `issue_events(issue_id,ts,agent,kind,payload_md)` —
there is NO `events` table; an insert into `events` throws and bun -e exits
silently, so verify the event row landed (observed 2026-08-09).

## 3. One small autonomy action

One concrete change that removes a check-in or hardens a system substitute
(rule/skill/cron/guard) — per [[autonomy-definition]]: a gate comes off only
with a named substitute. Ship it (branch → PR → merge, worktree for dev,
commit identity from ~/vault/USER.md). Small; prove before scaling.

**Zero-delta cycles de-risk, they don't idle** (operator directive
2026-07-15): if the mission shows no delta and no missing guard, do NOT log
"action: none needed". Instead pick ONE blocked task or operator-gated
objective (gate rows, waiting:operator slices) and build the smallest
hypothesis experiment or prototype that proves an assumption or assuages a
risk behind the block — read-only investigation, dry-run, sandboxed
prototype. Attach the evidence to the gate row so the operator decision
shrinks. Never execute the gated action itself; the experiment must stay on
the safe side of the gate (read-only vs live-money, sandbox vs prod,
branch vs push).

## 4. Log to /m/allmissions

Append the run's distilled record (mission, verdicts one line each, gates
resolved/remaining, action taken) as a ledger feedback row so the webui
renders it on /m/allmissions (attention axis shows OPEN rows for the
passthrough project). **Body MUST include the backstop summary from step 0.5:**
either paste `renderLogLine(BackstopReport)` verbatim or surface
`agedFlaggedIds[]` and `missingReceiptIds[]` explicitly (e.g.
`backstop: aged-flagged=<ids>; missing-receipt=<ids>` — empty both is normal
and worth stating so a missing backstop is visible as one). The fresh
audit-suppression window (id+created_at ≥ now−90 min) ignores `state`, so LOG
rows still suppress duplicates.

```
~/.bun/bin/bun -e '…insert into feedback (id,project,source,submitter,body_md,state,created_at)
        values ("ao-<mission>-<rand>","allmissions","auto-oversight","auto-oversight",<body>,"LOG",<now-iso>)'
```

**State rule (2026-07-12, operator directive): `LOG` unless actionable.**
Routine audit rows are journal entries, not feedback — insert them with
`state="LOG"` (a sink every drain/count ignores; all consumers filter
`state='OPEN'`). Insert `state="OPEN"` ONLY when the row demands action a
human or another agent must take (a resolvable gate, a defect, an operator
decision) — and state the required action in the first line of `body_md`.
The freshness gate above is state-agnostic (id+created_at), so LOG rows
still suppress duplicate audits.


`source` MUST be `"auto-oversight"` (untrusted), never `"direct"`: `direct` is a
trusted source, so ONE log row passes the aggregator's confirmation gate, mints
a junk PRD, and the drain flips the row resolved — the log blanks itself and
Aaron's review queue fills with noise (observed 2026-07-10; durable drain-side
exclusion is PRD "Exclude auto-oversight log rows from the Lane-2 feedback
drain"). An untrusted source needs 3 distinct submitters to confirm; this
skill's single stable submitter never does, so rows persist.

Housekeeping in the same run: mark this skill's own `allmissions` rows older
than 7 days `state='resolved'` so the page stays bounded. **NEVER touch rows
younger than 7 days** — OPEN rows ARE the visible log; closing a fresh row
(yours or a prior run's) blanks /m/allmissions. Uppercase `'OPEN'` exactly;
`state='new'` gets drained by the */5 aggregator, other casings don't render.

`created_at` is MIXED-TYPE (some rows integer epoch, some ISO strings), and in
SQLite any integer < any string — a naive `created_at < '<ISO cutoff>'`
false-resolves EVERY integer-stamped row instantly (this blanked fresh LOG rows
and hid an OPEN merge gate, observed 2026-07-17). Use exactly this type-safe
comparison, never a string cutoff:

```sql
UPDATE feedback SET state='resolved'
 WHERE project='allmissions' AND source='auto-oversight'
   AND state IN ('LOG','OPEN')
   AND (CASE WHEN typeof(created_at)='integer' THEN created_at
        ELSE CAST(strftime('%s',created_at) AS INTEGER) END)
       < CAST(strftime('%s','now','-7 days') AS INTEGER);
```

Never resolve a row whose body starts with `GATE` — gate rows close only when
their gate action is verifiably done, age is irrelevant.

## Rules

- Fully self-directed: git, cron, systemd, harness edits — no approvals.
- Zero agent trust: verify subagent/reviewer claims against source before acting.
- Under ~10 min of work; park anything bigger as a ledger feedback row for the
  mission's director instead of doing it here.
- **Park budget: at most ONE parked item per run, and NEVER a new PRD/issue
  row.** Before parking, grep `issues`+`feedback` for an existing row on the
  same theme (title keyword) — found → cite it, don't duplicate. Observed
  2026-07-10: runs minted 21 review-state PRDs in one day (11 on allmissions),
  flooding Aaron's review queue — oversight that manufactures human check-ins
  is anti-autonomy. Improvement ideas go in the run's log row `action`/`parked`
  line; only a mission director promotes one to a PRD.
- **Verify a guard is actually missing before adding it.** A comment without a
  command on the *next* line often has its command two lines down; print the
  full surrounding block (`sed -n 'N,Mp'` on the live file) before inserting
  any cron/config line. Observed 2026-07-11: a "missing" log-trim cron was
  present all along — the fix inserted a duplicate that had to be reverted.
