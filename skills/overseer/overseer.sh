#!/bin/bash
# overseer.sh — 15-minute herdr pane observer
# Observes all panes, detects stalls/errors, nudges, escalates

set -euo pipefail

STATE_DIR="/tmp/overseer-state"
LOG_FILE="$HOME/vault/director/overseer.log"
DIRECTOR_BD="$HOME/vault/director/.bd"

mkdir -p "$STATE_DIR"
mkdir -p "$DIRECTOR_BD"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "=== Overseer tick started ==="

# Get all panes
PANE_LIST=$(herdr pane list 2>/dev/null)

if [ -z "$PANE_LIST" ]; then
    log "ERROR: Could not get pane list from herdr"
    exit 1
fi

# Process each pane
echo "$PANE_LIST" | grep -o '"pane_id":"[^"]*"' | cut -d'"' -f4 | while read -r pane_id; do
    [ -z "$pane_id" ] && continue

    log "Checking pane: $pane_id"

    # Get recent output
    current_output=$(herdr pane read "$pane_id" --source recent --lines 50 2>/dev/null | tail -50)

    # Save to temp file for comparison
    current_file="$STATE_DIR/${pane_id}.txt"
    echo "$current_output" > "$current_file"

    # Compare with previous state
    if [ -f "$STATE_DIR/${pane_id}.prev.txt" ]; then
        diff_result=$(diff "$STATE_DIR/${pane_id}.prev.txt" "$current_file" | head -20)

        if [ -z "$diff_result" ]; then
            # No change — possible stall
            log "PANE STALLED (no output change): $pane_id"

            # Check if already nudged
            nudge_count=0
            if [ -f "$STATE_DIR/${pane_id}.nudge" ]; then
                nudge_count=$(cat "$STATE_DIR/${pane_id}.nudge")
            fi

            if [ "$nudge_count" -lt 2 ]; then
                log "Nudging stalled pane: $pane_id (nudge $((nudge_count + 1)))"
                herdr pane send-keys "$pane_id" enter 2>/dev/null || true
                echo $((nudge_count + 1)) > "$STATE_DIR/${pane_id}.nudge"
            else
                log "PANE STILL STALLED after nudges, escalating: $pane_id"
                # Escalate to director via beads
                # (would use bd create here)
            fi
        else
            # Output changed — reset nudge counter
            echo "0" > "$STATE_DIR/${pane_id}.nudge"

            # Check for error patterns
            if echo "$current_output" | grep -qiE "(error:|failed|timeout|denied|panic|segfault)"; then
                log "ERROR PATTERN detected in pane: $pane_id"
                # Would create beads issue and potentially spawn driver
            fi

            # Check for block indicators
            if echo "$current_output" | grep -qiE "(waiting|blocked|need human|please)"; then
                log "BLOCK INDICATOR detected in pane: $pane_id"
                # Would escalate to director
            fi
        fi
    fi

    # Update previous state
    mv "$current_file" "$STATE_DIR/${pane_id}.prev.txt"
done

# Clean up old state files (>24h)
find "$STATE_DIR" -type f -mtime +1 -delete 2>/dev/null || true

log "=== Overseer tick completed ==="
