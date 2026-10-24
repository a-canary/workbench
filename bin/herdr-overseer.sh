#!/bin/bash
# Herdr Overseer - scans panes every tick, reports errors as beads
# Run as: herdr-overseer.sh (one tick) or in a loop by the driver

STATE_DIR="${HERDR_OVERSEER_STATE:-/tmp/herdr-overseer}"
mkdir -p "$STATE_DIR"
REPORTED_FILE="$STATE_DIR/reported.jsonl"
touch "$REPORTED_FILE"

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "=== HERDR OVERSEER TICK $TIMESTAMP ==="

ISSUES_FOUND=0

# Scan all workspaces
for ws in $(herdr workspace list 2>/dev/null | jq -r '.result.workspaces[].workspace_id' 2>/dev/null); do
  panes=$(herdr pane list --workspace "$ws" 2>/dev/null | jq -r '.result.panes[]? | "\(.pane_id)|\(.agent_status)|\(.cwd)|\(.terminal_title_stripped)"' 2>/dev/null)
  [ -z "$panes" ] && continue

  while IFS='|' read -r pane_id status cwd title; do
    [ -z "$pane_id" ] && continue
    # Skip plain shells (unknown status with no agent in title)
    [[ "$title" != *"π"* && "$title" != *"$status"* ]] && continue

    # Read recent output and look for errors
    output=$(herdr pane read "$pane_id" --source recent-unwrapped --lines 50 2>/dev/null)
    [ -z "$output" ] && continue

    # Check for real errors (not just bg task failure counts)
    error_lines=$(echo "$output" | grep -iE 'Error:|FATAL|panic|Exception:|traceback|fatal:' | grep -v 'bg [0-9]* failed' | grep -v 'Compaction cancelled' | head -5)

    if [ -n "$error_lines" ]; then
      # Create a fingerprint for this issue
      fingerprint=$(echo "$pane_id|$error_lines" | md5sum | awk '{print $1}')

      # Check if already reported
      if ! grep -q "\"fingerprint\":\"$fingerprint\"" "$REPORTED_FILE" 2>/dev/null; then
        echo "[NEW ERROR] $pane_id ($status): $title"
        echo "$error_lines"
        echo ""

        # Report to beads (check for existing similar bead first)
        if command -v bd >/dev/null 2>&1; then
          existing=$(bd list --status open --label overseer --json 2>/dev/null | jq -r '.issues[]? | select(.title | contains("'$pane_id'")) | .id' 2>/dev/null | head -1)
          if [ -z "$existing" ]; then
            bd create --title "Overseer: error in $pane_id ($status)" \
              --type bug --priority 2 \
              --description "Auto-detected by herdr-overseer at $TIMESTAMP\n\nPane: $pane_id\nStatus: $status\nCWD: $cwd\nTitle: $title\n\nError output:\n$error_lines" \
              --labels "overseer,auto-detected" \
              >/dev/null 2>&1 && echo "  → Filed bead"
          else
            echo "  → Existing bead $existing, not duplicating"
          fi
        fi

        # Log as reported
        echo "{\"fingerprint\":\"$fingerprint\",\"pane\":\"$pane_id\",\"time\":\"$TIMESTAMP\"}" >> "$REPORTED_FILE"
        ISSUES_FOUND=$((ISSUES_FOUND + 1))
      fi
    fi
  done <<< "$panes"
done

# Check for stalled working agents (working > 30 min with no recent output change)
# This would require state tracking across ticks; simplified here

echo "=== END TICK ($ISSUES_FOUND new issues) ==="

# Prune reported file to last 100 entries
tail -100 "$REPORTED_FILE" > "$REPORTED_FILE.tmp" 2>/dev/null && mv "$REPORTED_FILE.tmp" "$REPORTED_FILE"
