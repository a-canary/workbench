#!/bin/bash
# arc-agents PreToolUse hook — block destructive ops; route rm to to-trash.
# Contract (Claude Code): hook input is JSON on stdin; exit 2 + stderr blocks the call.
# Worker context: ledger-dispatched, work happens in ~/worktrees/<repo>-<slug>/.

INPUT=$(cat)
[ "$(jq -r '.tool_name // empty' <<<"$INPUT")" = "Bash" ] || exit 0
CMD=$(jq -r '.tool_input.command // empty' <<<"$INPUT")

if grep -qE '\brm\s+-[a-zA-Z]*[rf]' <<<"$CMD"; then
  echo "HOOK_BLOCKED: rm -r/-f is blocked. Move target into ~/trash/\$(date +%s)_<name>-\$(date +%Y%m%d)/ instead (reversible, 30-day retention)." >&2
  exit 2
fi
if grep -Eiq 'git\s+push\s+(.*\s)?(--force|-f)\b|git\s+reset\s+--hard' <<<"$CMD"; then
  echo "HOOK_BLOCKED: destructive git pattern. Confirm intent before retry." >&2
  exit 2
fi
exit 0
