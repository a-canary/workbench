---
name: human-gate-post-webui
description: 'Surface a genuine human-gate or taste choice to the developer via the webui Feed without blocking on the reply. Rare by design; most uncertainty self-resolves via docs/ke/counsel. Use only when a decision is genuinely the human''s. Triggers: "surface this to the developer", "post a human-gate", "this needs Aaron''s call", "flag a taste choice".'
---

# Human-Gate-Post-Webui

The **non-blocking** channel for the rare decision only the developer can make.
The webui Feed (an `OPEN` feedback row) is the async surface; the developer
reads it on their approve/deny cadence. This skill posts the gate and **returns
you to other work in the same breath** — it is a note left on the board, never a
wait.

ADR-0011 (question-free execution): executing agents may not *ask and wait*.
Post-PRD uncertainty self-resolves via **docs · ke-research · /counsel**. This
skill is the narrow exception ADR-0011 keeps: a problem genuinely un-self-
resolvable is *reported to the Feed*, then execution continues elsewhere. If you
find yourself reaching for this more than rarely, the gate belongs earlier (in
planning Chat / a reference artifact), not mid-execution.

## 0. Is this actually a human-gate? (the filter)

Most things that *feel* like a gate are not. Before posting, rule out:

- **Self-resolvable** — docs, ke:recall, or /counsel can decide it. Then DO
  that; don't post. /counsel is the named substitute for the user on most forks
  ([[counsel-over-asking]]).
- **A default exists** — reversible + a sensible default? Take the default,
  note it in one line, proceed. A gate is for decisions with no safe default.
- **Not the human's to make** — a fact you can verify in the repo, a choice the
  code/CHOICES.md already settles. Verify, don't ask.

Post ONLY when the decision is genuinely the developer's: an irreversible or
outward-facing action, a taste/direction call with no right answer, or a
**human-gated class** — gate-removal, spend, publish, delete, account
([[hard-merge-standing-permission]] carve-outs). These are the real gates.

## 1. The latency test — is the gate cheaper than the wait?

The whole point. A human-gate costs **human-reply latency** (hours; on the
mobile cadence ~2-4h, overnight far longer). Before posting a *choice between
options*, price the wait against the options:

> Option A (5 min + $1) vs Option B (1 hr + $0), but the human is ~12 h away —
> waiting cost more than either option. You should have just PICKED one.

Rule: **if the wait costs more than the delta between the options, don't gate —
pick the reversible/cheaper-to-undo option and proceed**, logging the choice +
why you didn't wait (LOG row, not OPEN). Gate only when the options are
expensive or irreversible *enough that human-reply latency is the smaller cost*
— i.e. picking wrong is costlier than waiting. Spend/publish/delete/account
gates are (almost) always worth the wait because picking wrong is
irreversible; a two-way-door implementation choice almost never is.

State the latency reasoning in the post so the developer sees you did the math.

## 2. Write the gate — concise, evidenced, one row

One `feedback` row on `~/vault/ledger.db` (the Feed). Terse — the developer
reads this on mobile ([[response-style-caveman]], no visible timestamps):

```
id:      hg-<repo>-<slug>-<epoch>
source:  human-gate            (NOT 'direct' — 'direct'=trusted mints junk PRDs;
                                see [[auto-oversight-source]])
project: <repo>
state:   OPEN                  (action required — this is the whole point)
body_md: <request/scope-change in 1-2 lines>
         <evidence or reasoning — the facts that make it a gate, file:line refs>
         <the choice: option A vs B, or approve/deny, each with cost>
         <latency note: why gated not defaulted (§1 math)>
         <what you're doing meanwhile — the unblocked work you moved to>
```

- No `sqlite3` on this host — write via
  `PATH=$HOME/.bun/bin:$PATH bun -e '…bun:sqlite…'` ([[ledger-created-at-formats]]).
- `state=OPEN` is what makes it surface + demand action. A gate you can just log
  for the record is a `LOG` row, not a gate — if it's `LOG`, you didn't need §1.
- A verdict/evidence row is a **measurement** (UM-0500): cite real
  `file:line`/data, never a fabricated number to make the gate look urgent.

## 3. Keep moving — the non-negotiable half

The post is fire-and-forget. **Do NOT wait, poll, or ScheduleWakeup to check for
a reply.** Immediately:

1. **Find unblocked alternatives** — other issues on the board, other slices of
   the same PRD that don't depend on this decision, the next repo in the walk.
2. **Explore around the gate** — prototype BOTH options cheaply if that de-risks
   the eventual answer (a paper-prototype of each, thrown away when the human
   picks). Exploration that makes the human's choice better-informed is itself
   progress.
3. **Batch gates** — if several gates accrue, they land together on the
   developer's next cadence pass; that's fine. Don't serialize your own work on
   them.

The developer's reply arrives async as a feedback state-flip (OPEN→resolved) or
a fresh instruction — you act on it *when it comes*, not by blocking now. A gate
that stalled the agent until the human replied is a broken use of this skill
(it re-couples throughput to human latency, the exact thing ADR-0011 cut).

## Judging done

One concise OPEN feedback row per genuine gate (source='human-gate'), the §1
latency math shown, evidence cited real, and the agent already working something
else by the end of the same turn. A run that posted a self-resolvable question,
wrote source='direct', defaulted-able choice as a gate, or *waited* for the
reply is broken — redo it.
