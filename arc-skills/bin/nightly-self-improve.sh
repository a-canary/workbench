#!/usr/bin/env bash
# arc-skills nightly self-improvement: dream + token-waste + adaptation-review
# + agent knowledge-gap loop (extract-agent-gaps.py collector → /gap-remediate adaptor).
# Fires at 03:00 local; analyzes the day that just ended.
#   - dream is mtime-incremental (no date arg; picks up everything since last run)
#   - token-waste needs WASTE_DAY=yesterday or it only sees hours since midnight
#   - adaptation-review runs LAST and read-only: audits the trailing 10d of the
#     two adapters' edits for regressions/side-effects. REVIEW_DAY=yesterday so it
#     includes the night's own two changes in the window.
# The two adapters each make ONE edit; adaptation-review makes none (reports only).
# Unattended: runs via `pi -p` (print mode auto-approves tools) with a scoped
# --tools allowlist. Operational structure (captain 2026-08-28): Driver.Qwen +
# Defense Gate — the adapters (driver/workers) run via arc-llm-proxy
# (arc-proxy/driver alias: local Bonsai-27B on e103, Qwen3.8 on eVeles as
# failover), and after each editing stage an independent fresh-context model
# (DefendMerge tier, defend skill) attacks the stage's diff; ATTACKS => reset
# to pre-stage HEAD. Proxy routing per standing plan 2026-08-30 (replaces the
# 2026-08-27 direct-provider plan; the proxy hop is now mandatory for the
# factory lane so slots + audit logging are enforced). opus defense lane is
# dead machine-wide, so the gate runs on the same workhorse in a fresh session
# — GATE_MODEL overrides when opus returns.
# Review output via the daily journal (~/.claude/dream/journal/YYYY-MM-DD.md)
# and ~/.cache/arc-hygiene/*.log.
#
# Canonical + live copy: ~/repos/arc-skills/bin/nightly-self-improve.sh
# Cron invokes this repo path directly (no ~/.config mirror — the old symlink
# mirror was a drift trap and was removed 2026-08-27).
set -uo pipefail
SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
_lib="$SCRIPT_DIR/lib/log-event.sh"
. "$_lib" || { echo "FATAL: cannot source $_lib" >&2; exit 1; }
LOG_DIR="${LOG_DIR:-$HOME/.cache/arc-hygiene}"   # overridable for stub tests
mkdir -p "$LOG_DIR"
NIGHTLY_LOG="$LOG_DIR/nightly.log"
PI="${PI:-/usr/local/lib/node_modules/node/bin/pi}"  # overridable for stub tests
HYGIENE_MODEL="${HYGIENE_MODEL:-arc-proxy/driver}"  # Driver: proxy route (e103 Bonsai > eVeles Qwen)
GATE_MODEL="${GATE_MODEL:-arc-proxy/driver}"        # DefendMerge tier: fresh context, proxy route
GATE_REPOS="${GATE_REPOS:-$HOME/repos/arc-skills $HOME/repos/arc-agents $HOME/.pi/agent $HOME/vault}"
TOOLS="read,bash,edit,write"

# One instance at a time — a hung run must not stack with the next cron fire.
exec 9>"/tmp/nightly-self-improve.lock"
if ! flock -n 9; then
  log_event "$NIGHTLY_LOG" "$SELFIMPROVE_FAIL stage=lock exit=locked (previous run still holds the lock)"
  exit 0
fi

run() {  # run() <skill> <logfile>
  echo "== $(date -Is) /$1" >> "$LOG_DIR/$2"
  # 240m: slow local lane (single-slot box, minutes per idle prompt, queue-wait
  # when the box is busy). dream is incremental (processed.json) so a
  # timeout-killed run resumes next night.
  timeout 240m "$PI" -p --model "$HYGIENE_MODEL" --tools $TOOLS "/$1" \
    >> "$LOG_DIR/$2" 2>&1
  local c=$?
  log_event "$NIGHTLY_LOG" "$1 exit=$c"
  [ "$c" -ne 0 ] && log_fail "$NIGHTLY_LOG" "$1" "$c"
  return 0
}

# Defense gate (defend skill, DefendMerge tier): independent fresh-context model
# attacks the stage's edits before they stand. Adapters commit their own single
# edit; the gate reviews pre..HEAD plus any uncommitted remainder and resets on
# ATTACKS (untracked additions are quarantined to /tmp, never deleted).
snap_heads() {
  local repo
  for repo in $GATE_REPOS; do
    [ -d "$repo/.git" ] && echo "$repo $(git -C "$repo" rev-parse HEAD)"
  done > "${SNAP_FILE}"
}
gate() {  # gate <stage> — call after run(); no-op when the stage edited nothing
  local stage="$1" repo pre now diff verdict untracked
  while read -r repo pre; do
    now=$(git -C "$repo" rev-parse HEAD)
    diff=""
    [ "$now" != "$pre" ] && diff=$(git -C "$repo" diff "$pre"..HEAD)
    diff="$diff$(git -C "$repo" diff)"
    untracked=$(git -C "$repo" ls-files --others --exclude-standard | head -20)
    [ -n "$diff" ] || [ -n "$untracked" ] || continue
    log_event "$NIGHTLY_LOG" "gate $stage: edits in $(basename "$repo") — dispatching DefendGate ($GATE_MODEL)"
    verdict=$(timeout 30m "$PI" -p --model "$GATE_MODEL" --tools read,bash \
      "You are an independent defense gate (DefendMerge tier, defend skill). The nightly self-heal stage '$stage' just made these edits in $repo. Contract: at most ONE narrow system improvement; no regression to documented behavior; no rule bloat.\nDIFF (truncated 20k): $(printf '%s' "$diff" | head -c 20000)\nUNTRACKED ADDED: ${untracked:-none}\nMandatory lenses — answer each explicitly, 'no findings' is valid per lens: (1) does it break existing documented behavior? (2) is it more than one narrow change? (3) does it contradict AGENTS.md rules? Then free attack on anything else. Your final line must be exactly: VERDICT: CLEAR  or  VERDICT: ATTACKS" \
      2>&1 | tail -8)
    if printf '%s' "$verdict" | grep -q "VERDICT: CLEAR"; then
      log_event "$NIGHTLY_LOG" "gate $stage: $(basename "$repo") CLEAR"
    else
      [ "$now" != "$pre" ] && git -C "$repo" reset -q --hard "$pre"
      git -C "$repo" checkout -q -- . 2>/dev/null || true
      if [ -n "$untracked" ]; then
        local q="/tmp/gate-quarantine-$(date +%s)"
        local t="$q/$(basename "$repo").tar"  # separate line: same-line locals expand before assignment
        mkdir -p "$q"
        if (cd "$repo" && printf '%s\n' "$untracked" | tar cf "$t" -T -); then
          printf '%s\n' "$untracked" | (cd "$repo" && xargs -d '\n' rm -f --)
          log_event "$NIGHTLY_LOG" "gate $stage: $(basename "$repo") untracked quarantined to $q"
        else
          log_event "$NIGHTLY_LOG" "gate $stage: $(basename "$repo") quarantine tar failed — untracked left in place"
        fi
      fi
      log_fail "$NIGHTLY_LOG" "gate-$stage-$(basename "$repo")" 1
      log_event "$NIGHTLY_LOG" "gate $stage: $(basename "$repo") ATTACKS — reverted. $(printf '%s' "$verdict" | tr '\n' ' ' | tail -c 400)"
    fi
  done < "${SNAP_FILE}"
}

# Order matters: dream first, then token-waste — same daily journal.
log_event "$NIGHTLY_LOG" "nightly start"
SNAP_FILE="/tmp/gate-snap.$$"
snap_heads; run dream dream.log; gate dream
export WASTE_DAY="$(date -d yesterday +%Y%m%d)"
snap_heads; run token-waste token-waste.log; gate token-waste
# Safety net LAST: audit the trailing window (incl. tonight's two edits) for
# regressions. Read-only — spawns a reviewer subagent, makes no edits itself.
export REVIEW_DAY="$(date -d yesterday +%F)"
run adaptation-review adaptation-review.log

# Knowledge-gap loop (CAM): the AGENT's own confusion — facts it got wrong, was
# uncertain on, or the user had to correct — mined nightly and remediated.
#   stage 1 (collector, slow lane via arc-llm-proxy :8091): extract-agent-gaps.py
#     reads yesterday's sessions (claude + pi), appends dense gap lines to
#     ~/.claude/dream/agent-gaps.log. Its own timeout — run() wraps pi only.
#     Slow-burn, non-urgent.
#   stage 2+3 (adaptor, hygiene alias): /gap-remediate ranks the log by
#     severity×frequency, picks the top gap, checks AGENTS.md/MEMORY.md/ke, and
#     makes ONE add-or-clarify edit, logging the decision back. Runs via run().
GAPS="${GAPS:-$SCRIPT_DIR/extract-agent-gaps.py}"
echo "== $(date -Is) agent-gaps (slow lane)" >> "$LOG_DIR/agent-gaps.log"
timeout 120m python3 "$GAPS" >> "$LOG_DIR/agent-gaps.log" 2>&1
gc=$?
log_event "$NIGHTLY_LOG" "agent-gaps exit=$gc"
[ "$gc" -ne 0 ] && log_fail "$NIGHTLY_LOG" agent-gaps "$gc"
# gap-remediate is the second editing stage — same gate treatment.
snap_heads
run gap-remediate gap-remediate.log
gate gap-remediate
rm -f "${SNAP_FILE}"

log_event "$NIGHTLY_LOG" "nightly done (WASTE_DAY=$WASTE_DAY)"
