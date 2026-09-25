#!/usr/bin/env bash
set -euo pipefail; . "$(dirname "$0")/env.sh"
command -v bun >/dev/null || { echo "INFRA_FAULT: bun not in PATH"; exit 1; }
mkdir -p "$WORK"
[ -d "$FORK/.git" ] || git clone -q "$FORK_URL" "$FORK"
git -C "$FORK" remote add upstream "$UPSTREAM_URL" 2>/dev/null || true
[ -d "$PICR/.git" ] || git clone -q --depth 1 "$PICR_URL" "$PICR"
# deps are best-effort: peer @mariozechner/pi-coding-agent was renamed upstream,
# so a failed install is a warning here and an INFRA_FAULT at measure time.
( cd "$FORK" && npm i --no-audit --no-fund >"$WORK/npm-install.log" 2>&1 ) || echo "[warn] npm install failed; see $WORK/npm-install.log"
echo "clone ok fork=$(git -C "$FORK" rev-parse --short HEAD) picr=$(git -C "$PICR" rev-parse --short HEAD) budget=$TAIL_TOKEN_BUDGET"
