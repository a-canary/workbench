# Ponytail audit — arc-skills

Audit date: 2026-08-31. Tree audited: `ce38b8a` (origin/main). One-shot report; no fixes applied.

## Repo profile

- 64 skills under `skills/`, plus `bin/` ops scripts, `codemap/` snapshot, pointer-stub `arc-agents/`.
- Code: ~5.7k LOC — py 2003, ts 1942, sh 1353, js ~60. Markdown: ~11k lines (the product).
- **Zero npm dependencies.** No `package.json` anywhere; every script is bun/python/sh stdlib-only. Nothing to drop.
- No debt markers (`FIXME`/`TBD`; the only `XXX` match is an mktemp template in `skills/select-models/scripts/write-config.sh`). 13 files carry deliberate `ponytail:` debt markers (tracked by /ponytail-debt).

## Findings (ranked)

| # | Type | Where | What to cut / replace | Effort |
|---|------|-------|----------------------|--------|
| 1 | DUP | `skills/dream/scripts/extract.py` vs `skills/token-waste/lib/detect_waste.py` | `canonicalize_message` + `_PI_TOOL_NAMES` duplicated verbatim (~60 lines). **Keep as-is**: skills are standalone installable units with no shared-lib convention; unifying would require a cross-skill lib policy that doesn't exist. Revisit only if a third skill needs the same normalizer. | — (deliberate) |
| 2 | DUP | `bin/install-skill-agents.sh` vs `skills/install-behavioral-rules/inject.sh` | "move-to-trash before relink" contract duplicated (~10 lines). Same portability rationale as #1; bin/ and skills/ don't share helpers. Keep. | — (deliberate) |
| 3 | GAP | `skills/jsonl-db/lib/jsonl-db.ts` (79 LOC) | Library skill with no in-repo self-check or consumer test; the `watch()` incremental parser is the non-trivial part. Ponytail rule: non-trivial logic leaves one runnable check. Add a minimal `demo()`/assert self-check or a small `test_*.ts`. | S |
| 4 | NOTE | `arc-agents/src/director/*.ts` (3-line stubs) | **Not dead** — intentional pointer stubs to `~/repos/arc-director/src/driver/` (target verified present). `codemap/codemap.json` listing them is factually correct. No action. | — |

## Verified NOT dead (evidence-first, checked before flagging)

- `bin/prune-merged-branches.sh`, `bin/selfimprove-monitor.sh`, `bin/nightly-self-improve.sh`, `bin/arc-skills-doc-drift.sh` — all have live crontab entries on this box.
- `skills/dream/scripts/extract.py` — imported by `page.py` and `pipeline.py`; the "replaced pipeline" claim in `page.py` refers to the YAML-on-disk flow, not the module.
- `skills/capacity/*` (5 files) — every export referenced by `capacity.ts`, `validate.ts` (hermetic arcsim harness, documented in SKILL.md), or tests.
- `skills/wizard/template.sh` — generator asset for /wizard, referenced from design-taste-frontend.
- `codemap/codemap.json` file list matches the tree (no missing files at audit time).

## Verdict

The repo is lean: no speculative abstractions, no dead code, no unused flags, zero dependencies. The only real debt is finding #3 (jsonl-db self-check). Findings #1–#2 are deliberate portability trade-offs, not bloat.
