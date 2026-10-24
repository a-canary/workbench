---
name: dream
description: Mine conversation history for Claude's own failure modes, then make one system improvement
allowed-tools: Read, Write, Glob, Task, Bash
---

# Dream

Mine raw JSONL conversation logs for Claude's own mistakes, corrections,
hallucinations, and indirections, then make one concrete system change to
prevent the highest-impact recurring issue.

Two phases, two models. No intermediate file layers — the collector pages
sessions in memory and writes one append-only journal; the adapter reads it and
edits one thing.

```
sessions (~/.claude/projects/*/*.jsonl  +  ~/.pi/agent/sessions/*/*.jsonl)
        │  page.py streams 80-message windows (in memory, no YAML on disk)
        ▼
collector (haiku) ── Explore subagents on ambiguous failures
        │  appends mistakes / corrections / hallucinations / indirections
        ▼
~/.claude/dream/journal/YYYY-MM-DD.md   (append-only, one file per day)
        ▼
adapter (opus) ── picks ONE highest-impact issue (task-priority order)
        │
        ▼
one edit to an agent | skill | tool | pipeline | script
```

## Phase 1 — Collect (haiku)

1. Today's journal is `~/.claude/dream/journal/$(date +%F).md`. Create the
   `journal/` and `state/` dirs under `~/.claude/dream/` if missing.
2. Find sessions to process (incremental — skips unchanged):
   ```bash
   python3 ~/.claude/skills/dream/scripts/pipeline.py --list --limit 50
   ```
   This prints up to 50 new/changed session JSONL paths (oldest-mtime first),
   drawn from **both** source roots — interactive Claude Code
   (`~/.claude/projects`) and the headless `pi` agent fleet
   (`~/.pi/agent/sessions`); both normalize to one JSONL schema so the collector
   pages them identically. Checked against
   `~/.claude/dream/state/processed.json`. The `--limit` caps
   how many sessions one run drains so a cold start (thousands of unprocessed
   sessions) can't spawn thousands of agents in a single tick — the nightly
   cron works the backlog down over successive runs. Omit `--limit` only for a
   deliberate full sweep.
3. For each session, spawn a `collector` agent with the session path and the
   journal path. Run up to 3 in parallel (haiku is cheap, but cli-proxy has
   limited concurrency). The collector pages the session with `scripts/page.py`,
   digs into ambiguous failures with `Explore`, and appends findings.
4. After a session is **fully paged to `next_offset: EOF`**, mark it processed:
   ```bash
   python3 ~/.claude/skills/dream/scripts/pipeline.py --done <session.jsonl> --reached-eof
   ```
   `--done` now **refuses without `--reached-eof`** (exit 2). Only pass the flag
   once the collector reported reaching EOF for that session. If a session was
   skipped or only partially paged (e.g. "large session, not analyzed"), do NOT
   pass the flag -- leave it unmarked so `--list` requeues it next run. A
   skipped-but-marked-done session is silently lost from the pipeline forever
   (journal 2026-07-20).

## Phase 1b — User-signature review (HITL-gated proposals)
## Phase 1b — User-signature review (HITL-gated proposals)

While (or after) Phase 1 walks the session set, run DRY on the **user-role**
records from those same sessions. Goal: find repeating directive patterns
the operator types repeatedly — rules, behaviour directives, role codings,
`+<tag>:` annotations — that the agent should already know. Output is a
**proposal document, never an edit**; the operator (or `/director`) reads
it, decides what to apply, and only then is anything written.

Why HITL instead of auto-adapt (Phase 2): the *blast radius* of an inserted
global rule across every harness is large enough that operator sign-off
earns its place. A wrongly-phrased single-sentence rule loads into every
session from now on. Phase 2 keeps auto-applying bug/correction findings;
Phase 1b is for **shape** changes.

### Pipeline

```
user-role records (from Phase 1 session set, mtime-filtered to window)
       │  scripts/usersig.py
       │    • filter to directive-shaped records
       │    • cluster by difflib.SequenceMatcher (≥0.65) OR explicit "+rule:/Policy:/Global rule:" framing
       │    • map each repeat → target surface
       ▼
~/.claude/dream/proposals/usersig-YYYY-MM-DD.md   (append-only, one file/day)
       │
       ▼  HITL surface (per GLOBAL-RULES "Operator review goes to arc-webui as HTML")
       ▼  script also emits a human-gate bead row:
       │    bd|beads_create { kind: task, type: HITL,
       │                       title: "usersig-YYYY-MM-DD: review DRY user-statement proposals",
       │                       description: "<proposal path>" }
       ▼
AWAIT operator verdict → apply chosen rows / defer to a beads ticket / drop
```

### Cadence

- **Part of every `/dream` run** — runs alongside Phase 1 over the same
  session window (default 48h, `--window 7d` for backlog burn-down).
- **Ad-hoc:** `/dream --usersig` skips Phase 1+2 and runs only Phase 1b
  against recent sessions. Useful when the operator wants to inspect the
  current proposal doc without burning the full pipeline.

### Detection rules (`scripts/usersig.py`)

- **Window.** Default `--window 48h`. `--window 7d` for the weekly catch-up.
  The window is mtime-based on the session JSONL, matching Phase 1's
  discovery model.
- **Record filter.** User-role messages only. Skip:
  - acks (`yes`, `ok`, `go`, `resume`, `proceed`, `ping`, `done`, single
    letters `a`–`d`),
  - system-injected reminders (`<command-message>`,
    `<system-reminder>`, `[pi-midrun-compact/v1]`, "This session is being
    continued" / "Base directory for this skill" / "[Request interrupted
    by user" boilerplate),
  - pure tool-result content blocks (only `tool_use_id`/`tool_result`),
  - paste-confirm noise (`i updated CF token permissions` and similar
    flow-control during a credential setup),
  - empty / near-empty (`<15 chars` after trim).
- **Directive shape.** A candidate record satisfies EITHER:
  1. imperative-verb opener ("use", "drop", "stop", "never", "always",
     "don't", "move", "add", "skip", "fix", "write", "update", "remove",
     "delete", "create", "kill", "ship", "land", "merge", "commit",
     "verify", "check", "run", "set", "keep", "avoid", "prefer"),
  2. explicit framing tokens: `+rule:`, `+policy:`, `+todo:`, `+bd:`,
     `+feedback:`, `Global rule:`, `Global AGENTS.md rule:`, `Policy:`,
     `Rule:`.
- **Repeat threshold.** ≥2 occurrences inside the window, OR ≥1 occurrence
  when explicit-framing tokens are present (a single "+rule:" line is
  enough — the operator is *declaring* a rule).
- **Similarity threshold.** `difflib.SequenceMatcher.ratio() ≥ 0.65` on
  length-normalized lowercased text. Ponytail: stdlib clustering, no
  embeddings on the script — if precision drifts, swap in cosine later
  (`ponytail:` ceiling).
- **Skip if targeted diff is below budget.** If the cluster has only one
  directive-shaped occurrence and no explicit framing, drop; don't queue
  one-off task instructions as "patterns".

### Target-surface mapping

For each cluster, the script proposes a target surface using this priority
order:

| Pattern shape | Target |
|---|---|
| Cross-harness behaviour rule, "never/always" + agent scope | `GLOBAL-RULES.md` |
| Skill-local workflow rule | the relevant `<skill>/SKILL.md` |
| Role codification (Captain/Director/Driver/overseer) | `director/SKILL.md` (or the role-skill if separate) |
| Interaction convention (e.g. `+<tag>:` shorthand) | `GLOBAL-RULES.md` + the operational skill (e.g. `beads`) |
| Repo-specific working rule | `<repo>/AGENTS.md` (named in the proposal row) |
| One-off task content (not a rule) | NOT a proposal; logged as "noise" in the doc footer |

The mapping is a best-guess from keywords; the operator can re-target a
row during HITL review.

### Output shape (`~/.claude/dream/proposals/usersig-YYYY-MM-DD.md`)

```markdown
# User-statement DRY proposals — YYYY-MM-DD

Window: 48h (mtime)  •  Sessions scanned: N  •  Candidates: M

## Repeating directives

### `<target surface>: <one-line summary>`
- window occurrences: 2  •  sessions: 3  •  framing: "don't ask me for task priority"
- verbatim:
  > don't ask me for task priority, you work AFK until you have a
  > clarification about mission, scope change or taste prototype.
- proposed insertion: `GLOBAL-RULES.md` under "Always-on universal rules"
- rationale: appears as a verbatim rule across two operator turns in the
  same session; this is a cross-harness behaviour directive, not a task.

### `<next target>`

## One-off explicit rule declarations

### `<target>: <summary>`
- verbatim:
  > +policy|global rule: user must confirm changes to policy, CHOICES, …
- proposed insertion: `GLOBAL-RULES.md`
- rationale: explicit "+policy|global rule" framing → operator is
  declaring a rule; even with one occurrence in the window, queue as a
  proposal (the explicit-framing rule above).

## Noise ledger (drop, do not propose)
- ack/skip counts
```

### Integration with Phase 2

Phase 2 (Adapt, auto-applies ONE finding) is unchanged: it still picks the
**highest-impact** journal entry from today's `journal/` and edits one
thing. Phase 1b does NOT feed Phase 2. It produces a separate proposal
doc. The director (or operator) decides which rows apply.

If you want a single command to apply a chosen row from today's proposal
doc (codify an insertion at the proposed surface after HITL approval),
the adapter agent can be invoked with the proposal doc + the operator's
choice. That is the HITL→edit bridge; do not add it to Phase 2's
auto-loop.

### State files

- `~/.claude/dream/proposals/usersig-YYYY-MM-DD.md` — append-only,
  one file per day, latest wins as "today's proposal doc".
- `~/.claude/dream/state/usersig-processed.json` — incremental
  mtime-key tracking (same shape as `processed.json`), so a re-run only
  walks new sessions; last seen mtime per session JSONL.

### Manual

```bash
# full pipeline (default): runs Phase 1 + Phase 1b + Phase 2
/dream

# Phase 1b only — skip Phase 1 and 2
/dream --usersig
#   ↳ equivalent to:
python3 ~/.claude/skills/dream/scripts/usersig.py --window 48h

# burn-down last week's backlog
python3 ~/.claude/skills/dream/scripts/usersig.py --window 7d
```

`ponytail:` `usersig.py` ships without embedding-based clustering. If
verbatim-vs-paraphrase recall drifts (a tightly-phrased rule + a typo'd
rewrite of the same rule should cluster), swap the `SequenceMatcher`
clustering for a cosine pass over `Xenova/all-MiniLM-L6-v2` (Ke's
embedder) — same model, no new dep.

## Phase 1c — Beads scanning (systemic process failure detection)

Scan the central beads DB (`~/vault/director/.bd/`) alongside session transcripts.
Detect workflow-level patterns that session mining alone misses:

| Pattern | Query | Meaning |
|---------|-------|---------|
| Long-blocked tasks | Tasks `blocked` >24h | Process stuck, needs structural fix |
| Thrashing | `open`→`blocked`→`open` cycles | Spec unclear or worker mismatch |
| Undecomposed specs | `spec`/`epic` open >48h with no children | Director bottleneck |
| Unbalanced epics | Epic with >10 children or all same repo | Decomposition granularity wrong |
| QA rejection patterns | Tasks rejected by QA 2+ times | Test criteria or implementation pattern broken |

For each pattern detected, create an improvement ticket in the central beads DB
(type `task`, label `workflow-improvement`) targeting the process, not just the
agent. These feed Phase 2 as adaptation candidates.

## Phase 2 — Adapt (opus)

Before adapting, check `~/.claude/dream/state/watches.md` (standing watches —
multi-day sample-collection items). Update sample counts; when a watch's
criteria are met, its action is eligible as the day's adaptation. Mark CLOSED
when done.

Consider both session-mined findings (Phase 1) and beads-scanned findings
(Phase 1c) when selecting the day's adaptation. Workflow improvements (beads)
are prioritized when they affect multiple agents/repos.

Once collection is done, spawn one `adapter` agent with today's journal path. It
groups journal entries by root cause, picks the single highest-impact group
(task-priority order UX > quality > security > scale > efficiency; then
frequency × cost × reversibility), and makes exactly one edit to an agent /
skill / tool / pipeline / script. It appends an `## adaptation` block recording
what changed.

## Present results

Summarize: sessions processed, entry counts by type (mistake / correction /
hallucination / indirection), and the one adaptation the adapter made (surface,
file, rationale) — plus any runners-up it noted for the next run.

## Setup

The two phases run as custom subagents (`collector`, `adapter`) on a fast and a
smart model. They need a one-time install — see [SETUP.md](SETUP.md).

## Companion skills

- `/dream-status` — processing state and today's journal entry counts.
- `/dream-insights` — latest journal + adaptation without re-running.

## Incremental processing

`pipeline.py` tracks processed sessions in `~/.claude/dream/state/processed.json`
by source mtime. A session is reprocessed only when its JSONL changes. The
journal is keyed by day, so a session touched across two days contributes to
both days' journals.

## Output layout

```
~/.claude/dream/
├── journal/
│   └── YYYY-MM-DD.md        # append-only: entries + the day's adaptation
└── state/
    └── processed.json       # incremental mtime tracking
```

## Always-on rules (from AGENTS.md split)

- **Self-healing must recency-gate.** A journal/tally entry records when a problem was *observed*, not whether it's still live. Before fixing, confirm the live file still has the shape that caused the issue.
- **Diagnostic/self-healing subagents run on Claude opus + haiku only.** Cheap half = `model: haiku`, judgment half = `model: opus`. Never minimax or a `pi -p --provider` alias.
