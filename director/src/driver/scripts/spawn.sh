#!/usr/bin/env bash
# Factory spawn over treehouse pooled worktrees (DESIGN.md §3.1, slice 10).
# Replaces the G-0004 raw `git worktree add` pattern: acquires a pooled,
# lease-tracked worktree (deps/build cache survive reuse) and gates its base
# on the fetched origin tip before handing it to a worker.
#
# Usage: spawn.sh <repo-root> <task-slug> [--holder H] [--root R]
# Prints one JSON object on success:
#   {path, branch, base_sha, base, lease_id, holder}
# Exit codes: 0 ok · 2 usage/env · 3 stale base (lease released) · 4 acquire failed
#
# Fail-closed note: treehouse resets a reused slot to whichever of the local
# or remote default branch is ahead. A local main with unpushed commits would
# therefore hand out a non-origin base; the gate below rejects it. While that
# condition holds, spawns keep failing exit 3 — push (or reset) the local
# default branch to clear it. That is deliberate: workers start from the
# fetched origin tip, never from unpushed local state.

set -uo pipefail

die() { echo "spawn: $*" >&2; exit "${2:-2}"; }

[ $# -ge 2 ] || die "usage: spawn.sh <repo-root> <task-slug> [--holder H] [--root R]"
REPO_ROOT="$1"; SLUG="$2"; shift 2
HOLDER=""; ROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --holder) HOLDER="${2:?--holder needs a value}"; shift 2 ;;
    --root)   ROOT="${2:?--root needs a value}"; shift 2 ;;
    *) die "unknown flag: $1" ;;
  esac
done

[ -e "$REPO_ROOT/.git" ] || die "not a git repo: $REPO_ROOT"
command -v treehouse >/dev/null 2>&1 || die "treehouse not on PATH"

LEASE_JSON="$(cd "$REPO_ROOT" && treehouse get --lease --json ${ROOT:+--root "$ROOT"} ${HOLDER:+--lease-holder "$HOLDER"})" \
  || { rc=$?; echo "spawn: treehouse get failed (rc=$rc)" >&2; exit 4; }
WT_PATH="$(jq -r '.path' <<<"$LEASE_JSON" 2>/dev/null)" \
  || die "treehouse get returned no parseable JSON"
[ -n "$WT_PATH" ] && [ -d "$WT_PATH" ] || die "treehouse get returned bad path: $WT_PATH"
LEASE_ID="$(jq -r '(.lease_id // "")' <<<"$LEASE_JSON")"

# Base freshness gate: the worker must start from the fetched origin tip.
# treehouse fetches origin on acquire, so refs/remotes/origin/* is current.
DEFAULT_BRANCH="$(git -C "$REPO_ROOT" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')"
BASE="origin"
if [ -z "$DEFAULT_BRANCH" ]; then
  for cand in main master; do
    if git -C "$REPO_ROOT" rev-parse --verify --quiet "refs/remotes/origin/$cand" >/dev/null; then
      DEFAULT_BRANCH="$cand"; break
    fi
  done
fi
if [ -z "$DEFAULT_BRANCH" ]; then
  # Local-only repo: no origin to gate against; use the local default tip.
  BASE="local"
  DEFAULT_BRANCH="$(git -C "$REPO_ROOT" symbolic-ref --short HEAD 2>/dev/null || echo main)"
  TIP_REF="refs/heads/$DEFAULT_BRANCH"
else
  TIP_REF="refs/remotes/origin/$DEFAULT_BRANCH"
fi
TIP_SHA="$(git -C "$REPO_ROOT" rev-parse --verify --quiet "$TIP_REF")" \
  || die "cannot resolve $TIP_REF in $REPO_ROOT"
HEAD_SHA="$(git -C "$WT_PATH" rev-parse HEAD)"

if [ "$HEAD_SHA" != "$TIP_SHA" ]; then
  echo "spawn: stale base rejected: worktree at ${HEAD_SHA}, ${BASE} tip of ${DEFAULT_BRANCH} is ${TIP_SHA}" >&2
  treehouse return "$WT_PATH" ${ROOT:+--root "$ROOT"} >/dev/null 2>&1 || true
  exit 3
fi

# Per-task branch off the verified base (factory convention: worker/<slug>).
BRANCH="worker/$SLUG"
git -C "$WT_PATH" checkout -B "$BRANCH" >/dev/null 2>&1 \
  || die "cannot create branch $BRANCH in $WT_PATH"

jq -n --arg path "$WT_PATH" --arg branch "$BRANCH" --arg base_sha "$HEAD_SHA" \
      --arg base "$BASE" --arg lease_id "$LEASE_ID" --arg holder "${HOLDER:-$SLUG}" \
      '{path:$path, branch:$branch, base_sha:$base_sha, base:$base, lease_id:$lease_id, holder:$holder}'
