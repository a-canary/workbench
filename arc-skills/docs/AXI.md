# AXI — Agent Execution Interface (arc-skills variant)

A CLI-design contract for how any harness-agnostic agent (starting with `/director`)
talks to a delegation target's command surface, e.g. arc-agents' `ledger.ts <verb>`.
Adapted from the published [AXI ("Agent Experience Interface")](https://axi.md)
framework — same intent (token-efficient, reliable, discoverable CLI for agents),
one deliberate deviation: **output format**.

**Status: provisional.** This documents principles to apply, not a frozen verb
list — arc-agents' actual verb surface (`init`, `create`, `claim`, `decompose`,
`update`, `list`, `show`, `event`, `feedback`, `hitl`, `tick`, `spawn-ready`,
`compact`, `vacuum`, `doctor`, `alias-cmd`, `director-brief`, …) is the current
ground truth — see `arc-agents/bin/ledger.ts`. A full verb-stability pass (what's
contract vs internal) is deferred to a separate PRD, per
[arc-agents ADR-0012](https://github.com/a-canary/arc-agents/blob/main/docs/adr/0012-director-agent-axi.md).

## Adopted from axi.md

- **Minimal schemas** — default to 3-4 fields per row; let the caller ask for more.
- **Pre-computed aggregates** — return summaries the caller would otherwise need
  a follow-up round-trip to compute (e.g. `director-brief`'s done/current/next
  buckets, not raw rows the caller must bucket itself).
- **Definitive empty states** — an empty result renders as an explicit `(nothing)`
  or `[0]{}:`-style marker, never a blank string a caller might mistake for
  a truncated response.
- **Structured errors, clean exit codes** — a governor or verb never crashes
  the caller; failures are a return value, not a stack trace on stderr.
- **Content-first, ambient-context design** — verbs infer repo root, project,
  and other ambient state instead of demanding every flag every time.
- **Consistent help access** — `-h`/`--help`/`help` all resolve the same usage text.

## Deviation: no TOON

axi.md's headline efficiency claim is TOON output (~40% token savings over JSON).
This repo's position: **not adopted, pending contrary evidence.**

- arc-agents' own `toon-encode.ts` is a tabular/CSV-shaped format (`[N]{cols}:`
  header + comma-joined rows, RFC-4180 quoting) — structurally close to plain
  CSV, not a distinct wire format.
- Prior internal comparison (this session, unverified against a fresh benchmark —
  # hypothesis, not independently re-run here) found little-to-no measurable
  token or reliability advantage over plain JSON or CSV for this repo's row
  shapes, which are already small/flat (3-6 fields, no deep nesting).
- Cost: a bespoke encoding is one more format callers and tests must parse,
  for a savings this repo hasn't been able to reproduce.

**Verbs default to JSON.** `--csv` / `--md` are acceptable opt-in renders where
a human is reading directly. No verb should require TOON to be efficient.

If someone re-runs axi.md's benchmark methodology against this repo's actual
row shapes and finds a real, reproducible savings, that's grounds to revisit —
promote from hypothesis to decision at that point, not before.

## Not covered here

- Which verbs are stable contract vs. internal-only — deferred, see Status above.
- Browser/GUI automation verbs (`open --query`, `fill @id --submit`) from the
  source framework — arc-agents' surface is a task ledger, not a browser driver;
  not applicable.
