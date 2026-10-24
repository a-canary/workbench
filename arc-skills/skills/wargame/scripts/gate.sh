#!/usr/bin/env bash
# Ledger gate for /execute-wargame. Exits non-zero if any placeholder in the
# ledger's "Placeholders in play" table is still unresolved (❌ in the last cell).
# Usage: gate.sh <.wargame dir>
# ponytail: the ONLY deterministic step in execution — parse the ledger table,
# fail loud on unresolved rows. Everything else (move-walking, forks) is model judgment.
set -euo pipefail

WG="${1:?usage: gate.sh <.wargame dir>}"
LEDGER="$WG/ledger.md"
[ -f "$LEDGER" ] || { echo "GATE: no ledger.md at $LEDGER — nothing to gate, proceeding."; exit 0; }

# A placeholder row is a markdown table row starting with `| \`(...)\``.
# It is UNRESOLVED if the row contains ❌ (the Resolved? cell). Resolved rows use ✅.
unresolved=$(grep -E '^\| *`\(' "$LEDGER" | grep -F '❌' || true)

if [ -z "$unresolved" ]; then
  echo "GATE PASS: all ledger placeholders resolved."
  exit 0
fi

n=$(printf '%s\n' "$unresolved" | grep -c '❌')
echo "GATE FAIL: $n unresolved placeholder(s) — resolve in $LEDGER, then re-run:"
# print just the variable name (first backtick-quoted cell) of each unresolved row
printf '%s\n' "$unresolved" | sed -E 's/^\| *(`\([^`]+\)`).*/  - \1/'
exit 1
