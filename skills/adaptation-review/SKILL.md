---
name: adaptation-review
description: Read-only review of the last N days of self-healing changes by /dream and /token-waste for regressions — silent reverts, thrashing, broken surfaces, rule-bloat. Use to audit recent self-healing changes, check for regressions from /dream or /token-waste, or when asked "did the nightly adaptations break anything?".
allowed-tools: Read, Write, Glob, Task, Bash
---

# Adaptation-Review

`/dream` and `/token-waste` each make **one self-healing system change per day**,
every change attributable and reversible. Good in isolation — but a *stream* of
independent daily edits can rot the system in ways no single run can see:

- two runs **thrash** one file (edit, re-edit, fight over the same rule);
- a later edit **silently reverts** an earlier one;
- an adaptation claims a surface it **never actually wrote** (or wrote the wrong path);
- a script gets edited into a **syntax error**;
- every waste fix dumps another "remember not to" rule into the global rules
  (`~/repos/arc-skills/GLOBAL-RULES.md`) until they **contradict** each other.

This skill is the **safety net over the daily adapters**. It reviews the trailing
window of adaptations for regressions and side-effects, then **reports** — it is
read-only and makes no edits. The twins each make one change/day; this catches
the *interactions between* those changes, it doesn't add a third.

Two phases, mirroring its twins — but flipped in spirit (find, don't fix):

```
~/.claude/dream/journal/YYYY-MM-DD.md   (the daily adaptation audit trail)
        │  extract_adaptations.py — last N days, parse every `## adaptation`
        │  block, identify the surface each touched, run deterministic health checks
        ▼
/tmp/adaptation-review-<YYYYMMDD>.json   (shortlist + surface verdicts)
        ▼
regression-reviewer (opus) ── confirms each flag against the LIVE system + git
        │
        ▼
a regression report (read-only — names the fix, does not apply it)
```

## Phase 1 — Extract + health-check (deterministic)

A cheap Python pass does all the journal reading and surface sizing so the LLM
never loads the raw journals.

### Step 1 — Resolve the day + window

`REVIEW_DAY` (YYYY-MM-DD) overrides the end of the window; unset means today.
A nightly cron firing after midnight should set it to the day that just ended so
the window is unambiguous:

```bash
DAY="${REVIEW_DAY:-$(date +%F)}"
DAYC=$(date -d "$DAY" +%Y%m%d)
DAYS="${REVIEW_DAYS:-10}"
OUT="/tmp/adaptation-review-${DAYC}.json"
EXTRACT="$HOME/.claude/skills/adaptation-review/lib/extract_adaptations.py"
echo "day=$DAY window=${DAYS}d out=$OUT"
```

### Step 2 — Run the extractor

```bash
python3 "$EXTRACT" --days "$DAYS" --today "$DAY" > "$OUT"
```

It walks `~/.claude/dream/journal/` over the trailing `$DAYS` days, pulls every
`## adaptation` block (both `source: dream` and `source: token-waste`),
best-effort identifies the **surface file** each one touched, and runs
deterministic checks: `missing` (surface gone), `broken` (`.py`/`.sh`/`.json`
fails a parse check), `reverted` (a revert-like commit touched the surface in the
window), `thrash` (same surface edited by ≥2 adaptations), `conflict` (opposing
intent keywords on one surface), and window-level `rule_bloat` on the global
rules file (`~/repos/arc-skills/GLOBAL-RULES.md`).

Inspect the summary before spending an agent:

```bash
python3 - "$OUT" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
print(f"{d['adaptations_found']} adaptations over {d['window_days']}d "
      f"({d['days_with_journal']} days had a journal); sources={d['by_source']}")
print(f"thrash={len(d['thrash'])} rule_bloat={'yes' if d['rule_bloat'] else 'no'}")
flagged=[f for f in d['findings'] if f['verdicts']]
print(f"{len(flagged)} of {len(d['findings'])} findings carry a candidate flag")
PY
```

If `adaptations_found` is 0 (no journals in the window), report "nothing to
review — no adaptations in the last N days" and stop.

## Phase 2 — Confirm + report (regression-reviewer agent)

### Step 3 — Spawn the reviewer (one agent, opus)

```
Task: Review the last <DAYS>d of self-healing adaptations for regressions
Agent: adaptation-review:regression-reviewer
Prompt: Read <OUT>. Each candidate flag (missing / broken / reverted / conflict /
        thrash / rule_bloat) is a SUSPICION — confirm or dismiss each against the
        live system and git history, looking past prose-mention false positives.
        Also spot-check the intact surfaces for side-effects the deterministic
        pass can't see (a rule that now forbids a legit workflow, an interface
        change callers didn't follow). Report confirmed regressions worst-first
        with the smallest corrective action for each, plus dismissed flags and
        watch items. You are READ-ONLY — name the fix, do not apply it.
```

### Step 4 — Present

Relay the reviewer's report:

1. **Window** reviewed and adaptation count (dream/token-waste split).
2. **Confirmed regressions / side-effects**, worst-first — each with surface,
   the date(s)+source(s) of the adaptation(s) involved, what's wrong, and the
   named (un-applied) fix. If clean, say "no regressions found" plainly.
3. **Dismissed flags** — deterministic false positives, one line each, so the
   run is auditable.
4. **Watch items** — trending-wrong-but-not-yet-broken (e.g. the global rules
   file nearing rule bloat).

This skill **does not fix** anything. If it surfaces a real regression, the user
(or a follow-up `/dream` / `/token-waste` run, or a manual revert) acts on it.
Keeping find and fix separate is deliberate: the safety net must not also be a
self-modifying actor, or it could mask the very thrash it exists to catch.

## Setup

The review phase runs as a custom subagent (`regression-reviewer`) on the smart
model. One-time install — see [SETUP.md](SETUP.md).

## Relationship to /dream and /token-waste

A trio, not a pair:

- `/dream` → **effectiveness**: one fix/day for agent failure modes.
- `/token-waste` → **economy**: one fix/day for context waste.
- `/adaptation-review` → **safety**: read-only nightly audit of the *other two's*
  trailing changes, catching the cross-run interactions (thrash, silent reverts,
  rule contradictions, missing/broken surfaces) that a single daily adapter,
  seeing only its own one change, structurally cannot.

All three read the same `~/.claude/dream/journal/` audit trail. The adapters
**write** `## adaptation` blocks there; this skill **reads** them back and checks
they held up.

## Error handling

- No journals in the window → report "nothing to review" and stop (Step 2).
- Extractor error on the journal dir → it fails loudly; fix the path, don't
  spawn the agent on a partial file.
- A surface lives outside any git repo → `reverted` can't be checked there;
  the reviewer falls back to on-disk state only and says so.
- Reviewer returns nothing actionable → that's the good outcome: "no regressions
  found."
