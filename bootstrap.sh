#!/bin/bash
# bootstrap.sh: install workbench from pinned component versions
# Reads manifest.json to pull the exact tested combination.
#
# Usage: ./bootstrap.sh [--dry-run]

set -euo pipefail
WORKBENCH_DIR="$(cd "$(dirname "$0")" && pwd)"
DRY_RUN=0
if [[ "$1" == "--dry-run" ]]; then DRY_RUN=1; fi

run() {
    if [[ $DRY_RUN -eq 1 ]]; then
        echo "would run: $*"
    else
        "$@"
    fi
}

echo "workbench bootstrap (dry-run=$DRY_RUN)"
echo "qualified: $(jq -r '.qualified' "$WORKBENCH_DIR/manifest.json")"
echo ""

# --- Skills ---
echo "skills:"
SKILLS_REPO=$(jq -r '.components.skills.repo' "$WORKBENCH_DIR/manifest.json")
SKILLS_REF=$(jq -r '.components.skills.ref' "$WORKBENCH_DIR/manifest.json")
run git clone --depth 1 --branch "$SKILLS_REF" "$SKILLS_REPO" /tmp/wb-skills 2>/dev/null || true
run rm -rf ~/.pi/skills
run ln -sfn "/tmp/wb-skills/skills" ~/.pi/skills
echo "  → ~/.pi/skills (from $SKILLS_REPO @ $SKILLS_REF)"

# --- Proxy ---
echo "proxy:"
PROXY_REPO=$(jq -r '.components.proxy.repo' "$WORKBENCH_DIR/manifest.json")
PROXY_REF=$(jq -r '.components.proxy.ref' "$WORKBENCH_DIR/manifest.json")
run git clone --depth 1 --branch "$PROXY_REF" "$PROXY_REPO" ~/repos/arc-llm-proxy 2>/dev/null || true
echo "  → ~/repos/arc-llm-proxy (from $PROXY_REPO @ $PROXY_REF)"

# --- Pi config ---
echo "pi config:"
run cp "$WORKBENCH_DIR/pi/models.json" ~/.pi/agent/models.json
run cp "$WORKBENCH_DIR/pi/settings.json" ~/.pi/agent/settings.json
run cp "$WORKBENCH_DIR/pi/pi-settings.json" ~/.pi/settings.json
echo "  → ~/.pi/"

# --- Pi extensions ---
echo "extensions:"
run cp "$WORKBENCH_DIR/pi/extensions/"*.ts ~/.pi/agent/extensions/
run cp "$WORKBENCH_DIR/pi/extensions/"*.json ~/.pi/agent/extensions/ 2>/dev/null || true
echo "  → ~/.pi/agent/extensions/"

echo ""
echo "done."
echo "verify: ~/repos/harness-bench/bin/bench run smoke --label verify"
