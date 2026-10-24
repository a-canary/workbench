#!/usr/bin/env bash
# auto-oversight watchdog. The oversight skill rotates mission state BEFORE
# working, so a dead/timed-out run silently skips a mission and only cron.log
# knows. This observes the ledger after each 2h cron slot: no auto-oversight
# feedback row in the lookback window -> fire ONE notify.ts alert so the gap
# surfaces on Discord + director chat. Observation only; launches nothing.
#
# Migrated from a ledger-feedback write (bead director-vby): the feedback table
# is no longer an alerting channel, so the gap is reported via notify.ts. The
# SELECT still uses the feedback table because that is the audit trail.
set -uo pipefail
LOOKBACK_MIN="${LOOKBACK_MIN:-130}"
command -v bun >/dev/null 2>&1 || exit 0
NOTIFY_BIN="${NOTIFY_BIN:-$HOME/repos/arc-agents/bin/notify.ts}"
HOUR_ID="ao-watchdog-$(date -u +%Y%m%d%H)" LOOKBACK_MIN="$LOOKBACK_MIN" bun -e '
  const {Database}=require("bun:sqlite");
  const d=new Database(process.env.HOME+"/vault/ledger.db");
  const cutoff=new Date(Date.now()-Number(process.env.LOOKBACK_MIN)*60*1000).toISOString();
  const n=d.query("select count(*) c from feedback where source=\"auto-oversight\" and id like \"ao-%\" and id not like \"ao-watchdog-%\" and created_at>=?").get(cutoff).c;
  if(n===0){
    console.log("ALERT");
    process.stdout.write("**auto-oversight gap** — no audit row in last "+process.env.LOOKBACK_MIN+" min; the 2h cron likely died/timed out and its mission slot was consumed unaudited. See ~/vault/oversight/cron.log\n");
  } else { console.log("ok rows="+n); }' 2>/dev/null | {
  read -r status
  if [ "$status" = "ALERT" ]; then
    body=$(cat)
    bun "$NOTIFY_BIN" "Auto-oversight gap" "$body" \
      --source "auto-oversight-watchdog" --severity error || true
  fi
}