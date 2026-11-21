#!/usr/bin/env bash
# herdr-reviewer.sh — herdr-based Claude reviewer for defend-attack.
# Reads prompt from stdin, outputs review to stdout.
# Pool of 1 session per epic (DEFEND_EPIC_ID env var, default "default").
# Subscription billing (herdr), not API.
#
# Usage: echo "$prompt" | DEFEND_EPIC_ID=my-epic herdr-reviewer.sh
#
# Environment:
#   DEFEND_EPIC_ID: identifies the review pool (one session per epic)
#   HERDR_REVIEWER_WORKSPACE: herdr workspace id (default: detect first)
#   HERDR_REVIEWER_TIMEOUT: prompt timeout in ms (default: 300000)
set -euo pipefail

EPIC_ID="${DEFEND_EPIC_ID:-default}"
WORKSPACE="${HERDR_REVIEWER_WORKSPACE:-}"
TIMEOUT="${HERDR_REVIEWER_TIMEOUT:-300000}"
CWD="/tmp"

# Read prompt from stdin
PROMPT=$(cat)

# Derive unique agent name for this epic's reviewer
AGENT_NAME="reviewer-${EPIC_ID}"

# Step 1: Check if reviewer session for this epic already exists
if ! herdr agent get "$AGENT_NAME" >/dev/null 2>&1; then
    # Need to create a new session
    if [ -z "$WORKSPACE" ]; then
        WORKSPACE=$(herdr workspace list 2>/dev/null | jq -r '.result.workspaces[0].id // empty')
        if [ -z "$WORKSPACE" ]; then
            echo "[herdr-reviewer] ERROR: No workspace found" >&2
            exit 2
        fi
    fi

    # Create a tab for the reviewer
    TAB_ID=$(herdr tab create --workspace "$WORKSPACE" --cwd "$CWD" --label "$AGENT_NAME" 2>/dev/null | jq -r '.result.tab.tab_id // empty')
    if [ -z "$TAB_ID" ]; then
        echo "[herdr-reviewer] ERROR: Failed to create tab" >&2
        exit 2
    fi

    # Get the pane ID from the tab (via pane list)
    PANE_ID=$(herdr pane list 2>/dev/null | jq -r --arg t "$TAB_ID" '.result.panes[] | select(.tab_id==$t) | .pane_id' | head -1)
    if [ -z "$PANE_ID" ]; then
        echo "[herdr-reviewer] ERROR: Failed to get pane ID for tab $TAB_ID" >&2
        exit 2
    fi

    # Start Claude in the pane with read-only, no-skill config
    # Retry a few times like launch-pi-lead.sh does
    started=0
    for _ in 1 2 3 4 5 6; do
        sleep 3
        if herdr agent start "$AGENT_NAME" --kind claude --pane "$PANE_ID" \
            -- --safe-mode --permission-mode plan --allowedTools "Read,Glob,Grep" \
            --model opus --effort xhigh --strict-mcp-config \
            >/dev/null 2>&1; then
            started=1
            break
        fi
    done
    if [ "$started" -eq 0 ]; then
        echo "[herdr-reviewer] ERROR: Failed to start Claude agent" >&2
        exit 2
    fi
fi

# Step 2: Send the review prompt and wait for response
# --wait --until idle waits for the agent to finish processing
# The response is captured from the agent's output
herdr agent prompt "$AGENT_NAME" "$PROMPT" \
    --wait --until idle --timeout "$TIMEOUT" 2>&1
