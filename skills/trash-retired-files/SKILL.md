---
name: trash-retired-files
description: Safe, reversible file GC. A semantic reason drives scope — what counts as trash, what gets updated, what stays.
---

# trash-retired-files

Reversible garbage collection for codebases. Files go to `~/trash/`, not `/dev/null`.

## Core principle

**`--reason` is the primary input.** It is not a label — it determines:

1. Which files are candidates
2. Which candidates are trash vs need-updating
3. Which docs reference the trashed paths and need to be updated alongside

Without a reason, refuse to run. A sweep without a thesis turns into a regret.

## CLI shape

```bash
to-trash <path> --reason "<why>"        # move, log, mark with timestamp
to-trash <path> --reason "<why>" --dry-run   # preview + list referencing files
to-trash --restore <trashed-name>       # reverse
```

The skill is the procedure; the CLI is a thin convenience. Implementing a `to-trash` script is left to the consumer (see "Reference implementation" below).

## Naming convention

Trashed paths get a timestamp + relative-path suffix so concurrent moves and
basename collisions (e.g. two `CONTEXT.md` files in different dirs) stay
distinguishable and restores stay traceable:

```
~/trash/<unix-ts>__<relative-path>/
```

`<relative-path>` is the path of the trashed file relative to the repo root
(or the deepest common ancestor when trashing files from outside a repo),
with `/` rewritten to `--`. Examples:

```
~/trash/1782317031__contexts--encounters--CONTEXT.md/
~/trash/1782317031__contexts--tavern--CONTEXT.md/
~/trash/1782317031__PRD-v1.md/
```

`__` separates the timestamp from the path; `--` separates path components.
Neither can appear in normal POSIX paths, so collisions across distinct
files are impossible. If two files share an *identical* full relative path
(can only happen via a hardlink duplication), the script appends `-2`, `-3`,
etc.

**Why not just `<ts>_<basename>`?** Two files with the same basename in
different directories (`contexts/encounters/CONTEXT.md` and
`contexts/tavern/CONTEXT.md`) collided and the second move clobbered the
first — losing recoverable content. Observed in
`000109-hygiene-arc-webui-trash-retired-files` (arc-webui #10 sweep,
2026-06-24).

## Sweep procedure (manual, multi-file)

```
1. Parse the reason into a search pattern.
   "deprecated <module> pattern" → grep for refs across src/, docs/, scripts/

2. Locate candidates.
   grep -rn "<pattern>" . --include="*.{ts,py,md,sh}" \
     | grep -v "node_modules\|\.git\|trash\|archive"

3. Judge each hit:
   - TRASH if: archived dir, stale session/cache file, dead code path
   - UPDATE if: live code reference, doc that needs the new path
   - SKIP   if: protected (LICENSE, .git, lockfiles), in use, historical record

4. Bulk-trash via mv with timestamp suffix; single files via to-trash.

5. Update live docs that referenced trashed paths.
   grep for the old path → replace → verify with build/test.
```

## Retention

Default: **30 days** in `~/trash/`. After that, a separate cron (see `schedule-hygiene`) hard-deletes if disk pressure exists.


## Log format

Append a JSONL record per move to `~/trash/.log.jsonl`:

```json
{"ts":"2026-05-22T20:59:00Z","action":"trash","path":"src/legacy/old.ts","reason":"replaced by src/new.ts","trashed_to":"~/trash/1779389812__src--legacy--old.ts","refs_updated":3}
```

Sweep summaries get their own line:

```json
{"ts":"2026-05-22T21:00:00Z","action":"sweep","reason":"deprecated v1 API","trashed":12,"updated":4,"skipped":7}
```

## Guards

- Refuse `--reason ""` or missing reason
- Refuse paths inside `.git/`, `node_modules/`, or matching `LICENSE*`
- Check `lsof` on the path before moving (skip with `--force`)
- Never recurse into `~/trash/` itself

## Reference implementation

A ~60-line `to-trash` in shell. Computes the relative path from the repo
root (or first ancestor with `.git`) so concurrent moves of files with the
same basename in different directories land in distinct trash dirs:

```bash
#!/usr/bin/env bash
set -euo pipefail
path="$1"; shift
reason=""; dry=false; force=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --reason) reason="$2"; shift 2;;
    --dry-run) dry=true; shift;;
    --force) force=true; shift;;
    *) echo "unknown flag: $1" >&2; exit 2;;
  esac
done
[[ -z "$reason" ]] && { echo "--reason required" >&2; exit 2; }
[[ -e "$path" ]] || { echo "no such path: $path" >&2; exit 2; }

# Compute relative path from repo root (or absolute path if outside any repo)
abs="$(cd "$(dirname "$path")" && pwd)/$(basename "$path")"
rel="$abs"
dir="$(dirname "$abs")"
while [[ "$dir" != "/" ]]; do
  # -e not -d: in git worktrees, .git is a *file* pointing at the real gitdir
  if [[ -e "$dir/.git" ]]; then rel="${abs#$dir/}"; break; fi
  dir="$(dirname "$dir")"
done
# Sanitize: / → -- so the trash dir name is a single valid filesystem component
rel_sanitized="${rel//\//--}"

mkdir -p ~/trash
ts=$(date +%s)
dest=~/trash/${ts}__${rel_sanitized}
# Collision-guard for identical full paths (hardlink duplicates)
n=2
while [[ -e "$dest" ]]; do
  dest=~/trash/${ts}__${rel_sanitized}-${n}
  n=$((n+1))
done

if $dry; then
  echo "would move: $path -> $dest"
  echo "references:"
  grep -rln "$(basename "$path")" . 2>/dev/null | grep -v "^./\.git\|^./trash" || true
  exit 0
fi
$force || ! lsof "$path" >/dev/null 2>&1 || { echo "in use" >&2; exit 1; }
mv "$path" "$dest"
echo "{\"ts\":\"$(date -u +%FT%TZ)\",\"action\":\"trash\",\"path\":\"$path\",\"reason\":\"$reason\",\"trashed_to\":\"$dest\"}" >> ~/trash/.log.jsonl
echo "trashed: $dest"
```

## Restore

```bash
# 1. Find it
ls ~/trash/ | grep <name-fragment>

# 2. Move it back. <rel-path> is the original relative path
#    (trash dir name with __<ts>__ prefix stripped and -- restored to /):
mv ~/trash/<ts>__<rel-with-double-dashes> <rel-path>

# Example: 1782317031__contexts--encounters--CONTEXT.md -> contexts/encounters/CONTEXT.md
mv ~/trash/1782317031__contexts--encounters--CONTEXT.md contexts/encounters/CONTEXT.md

# 3. Revert doc updates if needed
git diff HEAD~ -- '<doc>'
```

## Termination

Drive to `merged` via bookie with `--evidence "trashed <N> files, updated refs in <files>"` and `--pr <branch-or-url>`.

**Zero-diff outcome.** Sweep found nothing retired (all candidates still referenced / below threshold), or the trash already happened at head: merge in place with no PR —

```
update <id> --state merged --no-diff --in-place --evidence "<negative result + where verified>"   # evidence ≤280 chars
```

Never open an empty PR to satisfy the merge guard. `--no-diff` skips the diff_review requirement; for a non-zero diff, emit exactly **one** `diff_review` event per sha (re-emitting 3–5× is ledger noise — pipeliner rows 000229/000256).
