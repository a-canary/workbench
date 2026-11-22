#!/usr/bin/env bash
# verify-decision.sh <db> <bead-id>
# Verify that a claimed operator DECISION exists on a bead.
#
# Usage:
#   verify-decision.sh ~/repos repos-esbpi
#
# Checks that the bead has at least one [operator] comment (from a-canary)
# containing a DECISION line. Prints the decision if found, or exits non-zero
# with an error if not.
#
# This is the tool half of repos-cj5sa: a receipt that a decision exists,
# not a comment the agent can write. The hitl-assistant must run this before
# claiming "operator already decided" on a bead.

set -euo pipefail

if [ $# -ne 2 ]; then
    echo "usage: verify-decision.sh <db> <bead-id>" >&2
    exit 2
fi

DB="$1"
ID="$2"

# Get the bead's comments as JSON
COMMENTS=$(bd -C "$DB" comments "$ID" --json 2>/dev/null || echo "[]")

# Check for [operator] comments with DECISION lines
# The operator's comments are from a-canary or operator, or start with "[operator]"
# A DECISION comment starts with "DECISION " followed by a verb (accept/reject/reply/refresh/skip/defer)
FOUND=$(echo "$COMMENTS" | jq -r '.[] | select(.author == "a-canary" or .author == "operator" or (.text | startswith("[operator]"))) | select(.text | test("^DECISION (accept|reject|reply|refresh|skip|defer)"))' 2>/dev/null)

if [ -z "$FOUND" ]; then
    echo "NO DECISION found on $ID (db: $DB)" >&2
    echo "No [operator] comment with a DECISION line exists on this bead." >&2
    echo "Do not claim the operator has decided. Leave the card with the operator or route it as a card." >&2
    exit 1
fi

# Print the decision(s) found
echo "DECISION found on $ID (db: $DB):"
echo "$FOUND" | jq -r '.text' | head -20
exit 0
