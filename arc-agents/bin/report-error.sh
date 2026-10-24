#!/usr/bin/env bash
# report-error.sh — route an error/warning to Discord + director chat
# (via arc-agents/bin/notify.ts) AND append a durable audit line to errors.log.
#
# Migrated from a ledger event-emit (bead director-vby): the ledger feedback
# table is no longer an alerting channel. notify.ts fans out to Discord
# webhook AND director chat (arc-chat post); errors.log keeps the audit trail.
#
# Usage:
#   report-error.sh [--issue <id>] [--severity error|warn|info] \
#                   [--source <component>] [--context <file>] \
#                   <one-line summary>
#
# Defaults:
#   --issue   $ARC_TASK_ID or $ARC_ISSUE_ID (the worker's claimed task)
#   --severity error
#   --source  the calling script (BASH_SOURCE[1])
#
# Exit 0 on successful route (notify is best-effort; the errors.log line
# is the durable guarantee). Exit 1 only on usage error.
set -euo pipefail

export PATH="${HOME}/.local/bin:${HOME}/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

ISSUE="${ARC_TASK_ID:-${ARC_ISSUE_ID:-}}"
SEVERITY="error"
SOURCE=""
CONTEXT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --issue) ISSUE="$2"; shift 2 ;;
    --severity) SEVERITY="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --context) CONTEXT="$2"; shift 2 ;;
    --to) shift 2 ;;  # accepted+ignored for backward compat (no agent inboxes)
    --) shift; break ;;
    *) break ;;
  esac
done

SUMMARY="${*:-}"
[[ -n "$SUMMARY" ]] || { echo "report-error: missing summary" >&2; exit 1; }

case "$SEVERITY" in error|warn|info) ;; *) SEVERITY="error" ;; esac

[[ -n "$SOURCE" ]] || SOURCE="${BASH_SOURCE[1]:-unknown}"

VAULT="${VAULT_DIR:-$HOME/vault}"
LOG="$VAULT/observations/errors.log"
mkdir -p "$(dirname "$LOG")"

now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

# Durable audit line — single-line, machine-parseable.
printf '%s\t%s\t%s\t%s\t%s\n' \
  "$now" "$SEVERITY" "${ISSUE:-none}" "$SOURCE" "${SUMMARY//$'\n'/\\n}" >> "$LOG"

# Route to Discord + director chat via notify.ts. Fire-and-forget; the errors.log
# line is the durable guarantee and notify failures are logged but do not
# change the exit code.
NOTIFY_BIN="${NOTIFY_BIN:-$HOME/repos/arc-agents/bin/notify.ts}"
TITLE="[$SEVERITY] $SOURCE"
[[ -n "$ISSUE" ]] && TITLE="$TITLE ($ISSUE)"
BODY="$SUMMARY"
[[ -n "$CONTEXT" ]] && BODY="$BODY (context: $CONTEXT)"
if [ -x "$NOTIFY_BIN" ] || command -v bun >/dev/null 2>&1; then
  bun "$NOTIFY_BIN" "$TITLE" "$BODY" --source "$SOURCE" --severity "$SEVERITY" >/dev/null 2>&1 || {
    echo "report-error: notify route failed; durable line saved to errors.log" >&2
  }
else
  [[ -n "$ISSUE" ]] || echo "report-error: no bun/notify available; saved to errors.log only" >&2
fi

exit 0