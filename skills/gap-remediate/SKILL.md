---
name: gap-remediate
description: Nightly CAM adaptor over the agent knowledge-gap log — ranks gaps in ~/.claude/dream/agent-gaps.log by severity × frequency, picks the single most critical one, and makes one narrow write to a knowledge surface (AGENTS.md / MEMORY.md / ke). Use when the user wants to close the top recurring agent knowledge gap, or asks what the nightly gap loop decided.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# gap-remediate — close the top agent knowledge gap

The precision-bounded **adaptor** of a CAM loop (see `/cam`). The cheap collector
(`extract-agent-gaps.py`, featherless Qwen3-32B) reads yesterday's sessions and
appends dense lines to the ledger:

```
~/.claude/dream/agent-gaps.log      # append-only, one gap per line
YYYY-MM-DD | topic | one-line correct fact the agent lacked | session8
```

You are the sole decision writer. Per run: **one** decision, **one** narrow edit
to a knowledge surface, **one** log line back. Never a partial or multi-surface
write. If nothing is worth changing, log a no-op — never force an edit.

## The knowledge surfaces (check all three before deciding)

1. **Global rules** — `~/repos/arc-skills/GLOBAL-RULES.md` (canonical; each
   harness's user-level config — `~/.claude/CLAUDE.md`, `~/.pi/agent/AGENTS.md`,
   … — symlinks to it). Always-on behavioral rules as `- **Rule.**`
   bullets. **Tightly curated — 56 lines. Adding here is expensive.** Only durable,
   universal *behavioral* doctrine belongs. Rule-bloat is a watched regression
   (`/adaptation-review`), so bias hard toward clarifying an existing bullet over
   adding one, and toward the other surfaces over AGENTS.md.
2. **MEMORY.md** — `~/.claude/projects/-home-aaron/memory/MEMORY.md` + the
   `*.md` files beside it. Project/factual memory: `- [Title](file.md) — hook`
   index lines pointing at one-fact files. Most gaps that are *facts* (a path, an
   API limit, a project constraint) belong here, not in AGENTS.md.
3. **ke** (semantic vault) — `ke recall-info "<topic>"` returns ranked `HITS:`
   with `%` scores + file paths. High-scoring hit that already states the fact ⇒
   it's covered there; the gap is a *recall* problem, not a *missing-fact* one.

## Steps

1. **Read the ledger.** `~/.claude/dream/agent-gaps.log`. Empty/absent ⇒ log
   "no gaps" and stop.
2. **Rank by severity × frequency.**
   - *Frequency*: how many lines share the same topic (normalize loosely — same
     subject, not exact string). Repeated across days/sessions = strong signal.
   - *Severity*: how wrong/costly the gap is. A gap that caused a user correction,
     a wrong destructive action, or repeated wasted work outranks a cosmetic one.
   - Pick the **single** top gap. Ties → higher severity wins.
3. **Check all three surfaces** for that topic (grep AGENTS.md + MEMORY.md &
   its files; `ke recall-info`). Classify:
   - **Covered & correct** anywhere ⇒ the gap is recall/discoverability. If a
     surface states it but weakly/buried, *clarify* it (sharpen the line). If it's
     clearly present and findable, log "already covered @ <surface>" and stop —
     do not duplicate.
   - **Present but wrong/stale/thin** ⇒ *clarify*: fix/sharpen that line in place.
   - **Absent everywhere** ⇒ *add* to the RIGHT surface:
     - durable universal behavior → AGENTS.md bullet (sparingly; match the
       `- **Terse rule.**` style, imperative, no hedging).
     - a fact/path/limit/project constraint → new MEMORY.md memory file +
       one-line pointer (follow the memory format the operator's CLAUDE.md
       defines: frontmatter + one fact), OR `ke` note. Prefer MEMORY.md for
       agent-facing facts that must load every session; `ke` for the long tail.
4. **Make exactly one narrow write.** Match surrounding style. No refactors, no
   drive-by edits to unrelated lines.
5. **Log the decision** back to the ledger, one line, so tomorrow's run sees it
   and frequency counting stays honest:
   ```
   YYYY-MM-DD | REMEDIATED | <topic> | <add|clarify|noop> @ <surface:file> | <one-line what changed>
   ```
   Append with `>>`, never rewrite the file.

## Guardrails

- **One write per run.** Multiple worthy gaps ⇒ take the top, note runners-up in
  the log line. The loop runs nightly; the rest keep.
- **AGENTS.md is not the default.** When unsure where a fact goes, it goes to
  MEMORY.md or ke, not AGENTS.md.
- **Never delete** existing rules/memories to "make room" — that's a separate
  reviewed action, not this adaptor's job.
- **Don't trust the collector blindly.** A gap line is a *claim* an open-source
  model made about a transcript. Before enshrining it, sanity-check it's real and
  correctly stated; a plausible-but-wrong fact in AGENTS.md is worse than absence.
  Verify checkable claims (a path exists, an API limit) before writing them.
- **Recency-gate.** If the top gap's fact is already live and correct on its
  surface, it was likely fixed already — log covered, don't re-fix.

## Always-on rules (from AGENTS.md split)

- **Self-healing must recency-gate.** A journal/tally entry records when a problem was *observed*, not whether it's still live. Before fixing, confirm the live file still has the shape that caused the issue (`git log` timestamp is a hint; live-file shape is authoritative). Never re-fix what's already fixed.
