#!/usr/bin/env bash
# Self-check for spawn.sh — proves the slice-10 evidence gate:
#   1. two concurrent workers spawn via treehouse (distinct pooled worktrees,
#      both at the fetched origin tip)
#   2. the pool retains a gitignored build cache across reuse
#   3. a stale base is rejected (local default ahead of origin → exit 3,
#      lease released)
# Runs against a throwaway fixture repo in /tmp with isolated pool roots;
# never touches ~/.treehouse. Exit 0 = all pass.

set -uo pipefail

SPAWN="$(cd "$(dirname "$0")" && pwd)/spawn.sh"
FIXTURES="$(mktemp -d /tmp/spawn-test.XXXXXX)"
trap 'rm -rf "$FIXTURES"' EXIT
PASS=0; FAIL=0

ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1" >&2; }

# --- fixture: bare origin + clone -------------------------------------------
git init -q --bare "$FIXTURES/origin.git"
git init -q -b main "$FIXTURES/repo"
cd "$FIXTURES/repo"
git config user.email t@t && git config user.name t
echo base > README.md
printf '.build-cache/\n' > .gitignore
git add . && git commit -qm base
git remote add origin "$FIXTURES/origin.git"
git push -q origin main
POOL="$FIXTURES/pool"
TIP="$(git rev-parse refs/remotes/origin/main)"

# --- 1. two concurrent workers spawn via treehouse ---------------------------
echo "test: two concurrent workers spawn via treehouse"
J1="$(bash "$SPAWN" "$FIXTURES/repo" task-a --root "$POOL")" || bad "spawn a failed"
if [ -n "${J1:-}" ]; then
  P1="$(jq -r .path <<<"$J1")"; S1="$(jq -r .base_sha <<<"$J1")"
  [ "$S1" = "$TIP" ] && ok "worker a at origin tip" || bad "worker a base $S1 != tip $TIP"
  [ "$(git -C "$P1" branch --show-current)" = "worker/task-a" ] && ok "worker a on worker/task-a" || bad "worker a branch wrong"
fi
J2="$(bash "$SPAWN" "$FIXTURES/repo" task-b --root "$POOL")" || bad "spawn b failed"
if [ -n "${J1:-}" ] && [ -n "${J2:-}" ]; then
  P2="$(jq -r .path <<<"$J2")"
  [ "$P1" != "$P2" ] && ok "leased slot not re-handed out (distinct worktrees)" || bad "same worktree handed to two workers"
  [ "$(jq -r .base_sha <<<"$J2")" = "$TIP" ] && ok "worker b at origin tip" || bad "worker b base wrong"
fi
# truly concurrent pair on a separate fresh pool root
POOLC="$FIXTURES/pool-concurrent"
bash "$SPAWN" "$FIXTURES/repo" task-c --root "$POOLC" >"$FIXTURES/jc" 2>/dev/null &
bash "$SPAWN" "$FIXTURES/repo" task-d --root "$POOLC" >"$FIXTURES/jd" 2>/dev/null &
wait
[ -s "$FIXTURES/jc" ] && [ -s "$FIXTURES/jd" ] \
  && ok "concurrent pair both acquired" \
  || bad "concurrent pair failed: $(cat "$FIXTURES/jc" "$FIXTURES/jd" 2>/dev/null)"
if [ -s "$FIXTURES/jc" ] && [ -s "$FIXTURES/jd" ]; then
  PC="$(jq -r .path "$FIXTURES/jc")"; PD="$(jq -r .path "$FIXTURES/jd")"
  [ "$PC" != "$PD" ] && ok "concurrent pair got distinct worktrees" \
    || { bad "concurrent pair collided: jc=[$(cat "$FIXTURES/jc")] jd=[$(cat "$FIXTURES/jd")]"; }
fi

# --- 2. build cache survives reuse ------------------------------------------
# Realistic lifecycle: worker builds (ignored artifact), lands its branch on
# origin, lease returns; the next acquire resets the same slot to the new tip
# and must keep the gitignored cache.
echo "test: pool retains gitignored build cache across reuse"
if [ -n "${P1:-}" ]; then
  mkdir -p "$P1/.build-cache" && echo artifact > "$P1/.build-cache/bundle.o"
  echo work >> "$P1/README.md" && git -C "$P1" commit -qam "task-a work"   # on worker/task-a
  treehouse return "$P1" --root "$POOL" >/dev/null 2>&1
  git -C "$P1" push -q origin HEAD:main                                  # land it
  git -C "$FIXTURES/repo" fetch -q origin
  TIP2="$(git rev-parse refs/remotes/origin/main)"
  J3="$(bash "$SPAWN" "$FIXTURES/repo" task-e --root "$POOL")" || bad "re-acquire failed"
  P3="$(jq -r .path <<<"$J3")"
  [ -f "$P3/.build-cache/bundle.o" ] \
    && ok "build cache survived reset+reuse (same slot: $([ "$P1" = "$P3" ] && echo yes || echo no))" \
    || bad "build cache lost on reuse"
  [ "$(jq -r .base_sha <<<"$J3")" = "$TIP2" ] && ok "reused slot reset to new origin tip" || bad "reused slot base wrong"
fi

# --- 3. stale base rejected ---------------------------------------------------
echo "test: stale base rejected (local main ahead of origin)"
git -C "$FIXTURES/repo" merge -q --ff-only origin/main   # local == origin first
git -C "$FIXTURES/repo" commit -q --allow-empty -m unpushed-local   # now strictly ahead
POOL3="$FIXTURES/pool-stale"
RC=0
bash "$SPAWN" "$FIXTURES/repo" task-f --root "$POOL3" >/dev/null 2>"$FIXTURES/err" || RC=$?
[ "$RC" = "3" ] && ok "stale base exit 3: $(grep 'stale base' "$FIXTURES/err" | head -1)" || bad "expected exit 3, got $RC: $(cat "$FIXTURES/err")"
# lease must be released after rejection — once local lands on origin, spawn works.
git -C "$FIXTURES/repo" push -q origin main
J4="$(bash "$SPAWN" "$FIXTURES/repo" task-g --root "$POOL3")" || bad "spawn after stale-reject failed"
[ -n "${J4:-}" ] && ok "pool reusable after stale rejection (lease was released)"

echo "result: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
