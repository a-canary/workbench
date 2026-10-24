---
name: hard-merge
description: Adversarial pre-merge review gate for merge-on-clear — the author drives it but dispatches a freshly spawned reviewer agent for independence (never reviews own work inline). Use before merging any PR you own, or when the user says "hard-merge", "merge-on-clear", or "adversarial review before merge".
---

# hard-merge — DefendMerge

This gate **is DefendMerge**, gate 2 of the Defend* family (see the `defend`
skill, merge.md): Worker(qwen|bonsai) → git merge. Workhorse tier,
fresh-context independence — no Opus; merges are frequent and git-reversible.

Adversarial review before a merge-on-clear. **Assume the diff is wrong; try to prove it; merge only when you fail.**

## Frame

Two roles, never the same agent. **Author** produced the diff and drives this gate. **Reviewer** is a **freshly spawned agent** (Agent/Task tool) that never saw the author's reasoning — the author does NOT play reviewer inline. Independence comes from a separate context, not from the author "putting on a reviewer hat." Author never approves own work; self-judge proves consistency, not correctness. Merge only when the spawned reviewer clears AND the local merge-gate is green. Reviewer/subagent reports are UNTRUSTED — the author verifies every checkable claim against source before acting on a CLEAR.

Dispatch the reviewer with: the PR/diff to review, "hunt for blockers, do not bless — this diff is wrong until you fail to break it", the §1-4 gate below, and "return a CLEAR/BLOCK verdict + findings ranked severe-first, under ~400 tokens, cite `file:line`, paste nothing." **Materialize the diff to a file ONCE** (`gh pr diff <n> > /tmp/pr<n>.diff`) and give every reviewer that one path — do not have each spawned reviewer re-run `gh pr diff` into its own context, and tell them to Read it ranged/per-hunk (`grep -n` the file for the target, Read that offset) rather than whole. With 2-3 disjoint reviewer contexts each reloading the full diff, that whole-diff reload is this gate's top token bleed; one shared on-disk copy, read ranged, pays it once. Confirm the PR head SHA hasn't drifted since dispatch before trusting the verdict. On a **production surface** (§4) spawn a *second* reviewer in its own separate context — two disjoint agents on record, not one — because a single agent sign-off there reads as self-approval.

Default posture: *this diff is wrong until the spawned reviewer fails to break it.*

## The gate — hard-fail short-circuits, cheapest first

### 1. Mechanical (binary, no judgment)
- [ ] Tests green — and the *right* tests. Baseline: did they fail before the change? A test passing at both HEADs proves nothing.
- [ ] Lint/format/typecheck on the **diff files**, not "repo looked fine." `biome check` = format + lint; a formatter error in your own files hides behind pre-existing warnings.
- [ ] CI conclusion on the **head SHA**, not reviewer-local env (reviewer-local-green masks CI-red when reviewer holds a secret CI lacks). Check-runs 403 -> gate on `mergeStateStatus=CLEAN` + predict CI locally.
- [ ] Merge state terminal, re-polled at merge time: `OPEN, MERGEABLE, CLEAN`, all checks `COMPLETED/SUCCESS`.

### 2. Shape of the change
- [ ] **`git diff` read line-by-line** — every hunk, the actual lines, not the summary.
- [ ] **Codemap/structure diff** — module shape change the PR didn't claim? New seam, new dependency edge, dead code introduced?
- [ ] **Nitpick out-of-scope changes** — files the ticket never mentioned, drive-by reformat, unrelated "while I was here" fix, unrequested version bump. Each is a blocker, not a courtesy.
- [ ] **Nitpick unneeded files** — new file that adds no value or duplicates existing code; scratch/debug/backup files (`*.tmp`, `*.bak`, `*-backup.*`, `k.sh`, `r.sh`); committed build output, logs, dumps, `.env`. Should it be deleted or gitignored instead of merged? Flag it.

### 3. Adversarial reasoning (the expensive part)
- [ ] **Name every assumption** the change makes: input non-null? list sorted? single writer? clock monotonic? Each unstated assumption is a latent bug — an assumption you can't name you can't check.
- [ ] **What-would-make-this-wrong** — for each assumption, the concrete input/state that violates it: empty list, concurrent writer, clock skew, 10k rows, non-ASCII, retry firing twice. Name the breaking case -> it's a finding.
- [ ] **Top risks**, ranked: data loss > silent corruption > crash > wrong output > perf. Worst thing this diff does if my worst assumption holds?
- [ ] **Principles/rules violated** — vs project doctrine (CLAUDE.md, ADRs, coding-standards), not vibes. Red gate footnoted out-of-scope? Trust boundary with validation stripped? New dependency where a few lines would do? Abstraction with one implementation?

### 4. Independence + escalation on the production surface

Two problems get handled here, and they are NOT the same problem. **Independence** (who signed off — are two *disjoint contexts* on record?) is handled by adding reviewers. **Blast radius** (how far can this diff blow?) is handled by `/counsel`'s judgment breadth. Do not use a `/counsel` panel to fix an independence gap — a panel is 5 experts spawned from the *author's own context*, so it does not add a disjoint reviewer any more than the author "putting on a reviewer hat" does (see [Why this order](#why-this-order)). What adds independence is a *second freshly spawned reviewer*.

Decide the merge target first: is it a **production surface** — a branch with GitHub protection rules requiring review, OR one your repo names as a deploy target (an unprotected default branch on a pure-docs/tooling repo is NOT one)? Check it observably (`gh api repos/<o>/<r>/branches/<b>/protection` → 200 = protected; else consult the repo's deploy config), don't eyeball "feels like main."

- [ ] **Production surface, small radius -> two disjoint reviewers, no panel.** Author + one spawned reviewer are both agent sessions; a two-party-review policy (or a merge classifier) reads a single agent sign-off on a production branch as self-approval. Close that with a **second freshly spawned reviewer from a disjoint context** — two independent CLEARs, cheap. A one-line doc/config fix on a production branch needs the second reviewer, not a 5-expert panel; reserve the panel for radius (below).
- [ ] **Non-small blast radius (any target) -> STOP and run `/counsel`.** Estimate blast radius. **Small** = reversible, contained, low-stakes: a single skill/doc/config file, a leaf function with tests, an additive change behind a flag. **Non-small** = anything that can hurt broadly or is hard to undo: schema/migration, auth/security/trust boundary, money path, deploy/infra/CI, a shared lib or interface many callers depend on, data deletion/backfill, public API, or a diff touching many modules at once. Non-small on a production surface -> the panel AND two reviewers. No spawned reviewer, however independent, is enough judgment for a change that can go broadly wrong — that is what the 5-expert panel is for.
- [ ] **Reviewer returns not-CLEAR on a production surface -> escalate to `/counsel`** even if radius looked small: a disputed production merge is exactly where a wider panel earns its cost.
- [ ] Neither holds (non-production target AND small radius AND reviewer CLEAR) -> the single spawned reviewer suffices; proceed to verdict.
- [ ] **A second reviewer and `/counsel` are advisory, not a mechanical unlock.** A harness/merge classifier cannot observe that counsel (or a second reviewer) ran, so it may still block a production merge after everything CLEARs. When it does -> fall back to a human for the final merge click; do NOT fight or work around the block. The panel bought you judgment breadth and an audit trail that the policy was satisfied — it did not, and cannot, satisfy a classifier that can't see it. Surface the block and stop.

### 5. Verdict
- [ ] Every checkable claim in the author's PR text verified against source — grep the constant, don't trust prose.
- [ ] Findings ranked most-severe first. Blocker -> back to author, not merged with a footnote (red gate = one obligation).
- [ ] Merge ONLY when the required reviewer(s) return CLEAR and their checkable claims verify against source: one reviewer for a non-production small diff, **two disjoint reviewers** for a production surface, and — whenever §4 required it (non-small radius, or a not-CLEAR reviewer on a production surface) — `/counsel` cleared too. The author merges after verifying the verdict — reviewers and the panel advise, they do not merge. Reversible path preferred; export-to-trash before any delete.

### 6. Post-deploy verification (production surface only)

The gate above clears a *diff*. It cannot clear what only exists once the change is live — how the copy actually renders, whether generated text reads as editorializing, whether text comes through mangled, whether the deploy dropped or duplicated anything a citizen sees.

- [ ] After the merge **deploys to the live production surface**, run `/qa` against that live surface — not the diff, the running site. This is a *sequence*, not a second pre-merge gate: `/hard-merge` gates the merge, deploy happens, then `/qa` verifies the deployed result. This `/qa` must emit its `qa.passed` with `phase:post-deploy` so the director can tell the live-surface pass (which closes the production gap) from the pre-deploy diff pass (which does not).
- [ ] Route `/qa` findings to the next gap tick (they are the observed-in-production input to the mission's gap list, not blockers you already owned).
- [ ] A **critical / truthfulness** finding on the live surface is a rollback trigger — revert the deploy (reversible path first), then re-open the gap. Don't leave a truth-defect live while you re-plan.

Non-production targets skip this — there's no live surface to verify against.

## Why this order

Broken build makes reasoning moot — don't spend tokens reasoning about a diff that doesn't typecheck. Assumptions before risks: can't rank what you haven't named. §4 sits after reasoning, before verdict, and separates two things people conflate. **Independence** is a property of *context*, not intent — the same head can't blind itself to its own reasoning, which is why the reviewer is a fresh spawn, not the author in a reviewer hat. On a production surface a *single* agent sign-off still reads as self-approval to a two-party policy, so you add a *second disjoint reviewer* — the fix for an independence gap is another independent context, cheaply. It is NOT a `/counsel` panel: a panel is 5 experts spawned from the author's own context, so it adds judgment breadth, not a disjoint reviewer. That is why `/counsel` gates on **blast radius** (and on a disputed production merge), not on target-is-main alone — you can only judge how far a change can blow once you've named its risks, and a change that can go broadly wrong needs more judgment than any lone reviewer holds. And because a merge classifier can't observe that either the second reviewer or the panel ran, neither is a mechanical unlock — they satisfy the *policy*; a blocking classifier is a harness limitation you surface to a human, not fight. Verify-against-source last: most expensive, only matters once the diff looks plausible. And §6 sits *after* the merge because it verifies a different object than every step before it: §1-5 reason about a diff, §6 observes a deployed surface. A truthfulness defect — a summary that reads as law, statutory text rendered mangled, a card that lost its "demo" label — is invisible on the diff and only appears once a citizen could load the page. On a production surface the merge is not the end of the gate; the deploy is, and the only way to close that loop is to look at what actually shipped.
