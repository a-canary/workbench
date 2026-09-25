---
name: ke
description: Knowledge Engine — one CLI for semantic recall, gap-driven research (web→ingest), and persisting durable learnings to a local sqlite-vec-indexed vault (Xenova/all-MiniLM-L6-v2, no API key). Use for R&D recall before starting work, INSTEAD of raw WebSearch on durable questions, and to bank any durable finding (verdicts, gotchas, decisions).
---

# ke — Knowledge Engine

One CLI tool, one skill. Binary: `ke` (`~/.bun/bin/ke`; fallback `bun ~/repos/ke/bin/ke-tool.ts`). KB at `~/vault/ke/` (local sqlite-vec index, embeddings via Xenova/all-MiniLM-L6-v2 — no server, no API key). `ke` with no args prints full usage.

## Verbs

| Verb | Command | Use |
|------|---------|-----|
| **search** | `ke search "<q>" [--limit N] [--tag T] [--diverse]` | Semantic vector search → ranked `[score%] title → path`. Look up prior decisions/fixes/patterns before acting. |
| **research** | `ke research "<q>" [--depth N]` | RECALL + fill ≤N gaps web→ingest. `--depth 0` = recall-only (no fetch/write). Each depth = one web→ingest pass on the top remaining gap; gaps return as a value, you decide whether to go deeper. |
| **update** | `ke update "<path>" --content "..."` / `echo … \| ke add "<topic/title>"` | Persist a durable learning. Queue at session end, after a fix, after research. |
| **learn** | `ke learn "<fact\|@file\|url>" [--topic T]` | Ingest caller-supplied material directly (atomizes + indexes, `src:learn`). No crawl. |
| **select** | `ke select [--tag T] [--topic T] [--regex P] [--after D] [--before D] [--format yaml]` | Exact-match filter (AND logic). Machine-readable with `--format yaml`. |
| **pending** | (see "background jobs" below) | Inspect background `ke research` jobs the prompt-hook spawned. |
| others | `query`, `compile`, `list`, `maintain`, `stats`, `audit`, `dispute`/`support`/`resolve` | Run `ke` with no args for usage. |

## Recall before deriving

Search BEFORE re-deriving anything plausibly studied before (experiments, infra gotchas, library pins). Hooks in `hooks/` already auto-inject precedent on prompt/stop in wired projects — don't re-search what a hook just injected.

## Use `ke research` INSTEAD of raw WebSearch/WebFetch

About to WebSearch a **durable** question (library tuning, method comparison, architecture tradeoff, benchmark *finding*, infra config/gotcha)? Use `ke research` instead. WebSearch answers evaporate — the next agent re-runs the same search. `ke research` recalls prior KE work first, fills only the remaining gap from the web, and ingests it — so the gap closes **once**, not every session.

Reserve raw WebSearch/WebFetch for **volatile** facts a cached copy would make *worse* (an agent quotes the stale value) — see *What KE never stores* below.

KE's web egress runs on the local `free-search` CLI (multi-engine, no API key). Never curl search engines directly — they block datacenter clients; use `free-search search|fetch` or the `websearch` skill.

## What KE stores / never stores

KE is permanent memory. Store: decisions + trade-offs, fixes + root cause, failure modes, architectural patterns, conceptual explanations, cached facts with provenance.

**Never** store:
- ephemeral values — counts, sizes, durations, status flags, inventories, estimates, action items, phase/state.
- the **volatile** class — facts whose value changes on a timescale that makes a cache a liability: **prices** (API/hardware/asset), **"current"/"latest" anything** (latest model, current version, today's SOTA score), a URL's present state, breaking news. Fetch these live every time.

Borderline? Store the durable shape, drop the volatile number — "Haiku is the cheap tier; fetch live pricing" not "Haiku costs $X/Mtok". Notes terse: verdict first, then evidence ref (`url | file:line | cmd`). No prose padding.

## Correcting a claim

KE claim observed false → `ke dispute <path> --why "<one-line>" --evidence "<file:line|cmd|url>"`. Verified true → `ke support` (same flags). Never edit/delete on own judgment. Disputed notes inject demoted + `[DISPUTED]`; settle via `ke maintain` queue → `ke resolve <path> --verdict confirmed|corrected|refuted` (corrected = fix the body first, once).

## Background research jobs (pending)

The plugin's `UserPromptSubmit` hook spawns background `ke research` jobs when a prompt looks substantive but KB coverage is weak; findings auto-inject on the next matching prompt. To inspect or force-read early:

```bash
# list jobs: status, age, query
for d in ~/.cache/ke-plugin/jobs/*/; do [ -f "$d/meta.json" ] || continue
  printf "%-10s %s\n" "$(cat "$d/status" 2>/dev/null||echo ?)" "$(jq -r .query "$d/meta.json")"; done
# read a done job's evidence directly
cat ~/.cache/ke-plugin/jobs/<id>/evidence.md
```

States: `running` · `done` (awaiting relevance check) · `delivered` · `stale` (>30min or no match) · `failed`. Cleanup old jobs: `find ~/.cache/ke-plugin/jobs -mindepth 1 -maxdepth 1 -type d -mtime +1 -exec rm -rf {} \;`.

## Multi-topic research batches

Operator often dispatches several `ke research` lines in one turn (typical
pattern from `+bd:` style annotations and `/director` HITL). Each line is a
**separate** topic — fan them out as **independent** background jobs (or
sequential `ke research "<topic>"` invocations), not one combined query.
Don't synthesize-across-topics in one shot: each topic gets its own
recall+gap+ingest pass; the operator synthesizes the answers in the
following turn. If a turn arrives with N topics, run N `ke research` calls,
then report per-topic status.
