#!/bin/bash
# daily-sweep.sh: vet component repos, test, publish working upgrades
#
# Flow:
# 1. Check each pinned component for new commits since last sweep
# 2. If changes: test with harness-bench
# 3. If tests pass: update manifest.json to new ref
# 4. Publish: commit + push manifest change
# 5. If tests fail: leave manifest as-is, report
#
# Usage: ./nightly/daily-sweep.sh [--dry-run]

set -euo pipefail
WORKBENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS_BENCH="/home/aaron/repos/harness-bench"
SWEEP_LOG="$WORKBENCH_DIR/BENCH/sweep-$(date -u +%Y-%m-%d).log"
DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY_RUN=1; fi

log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$SWEEP_LOG"; }

run() {
    if [[ $DRY_RUN -eq 1 ]]; then
        echo "[dry-run] would run: $*"
    else
        "$@"
    fi
}

log "=== daily sweep start ==="

# Component to sweep: skills
COMPONENT="skills"
REPO=$(jq -r ".components.$COMPONENT.repo" "$WORKBENCH_DIR/manifest.json")
CURRENT_REF=$(jq -r ".components.$COMPONENT.ref" "$WORKBENCH_DIR/manifest.json")
COMPONENT_DIR="$WORKBENCH_DIR/.sweep-$COMPONENT"

# Clone/fetch component
if [[ ! -d "$COMPONENT_DIR/.git" ]]; then
    run git clone --depth 50 "$REPO" "$COMPONENT_DIR"
else
    run git -C "$COMPONENT_DIR" fetch origin
fi

# Check for new commits
LATEST=$(run git -C "$COMPONENT_DIR" rev-parse origin/main 2>/dev/null || echo "")
if [[ -z "$LATEST" ]]; then
    log "ERROR: could not get latest ref for $COMPONENT"
    exit 1
fi

log "$COMPONENT: current=$CURRENT_REF latest=$LATEST"

# If no new commits, skip
if [[ "$CURRENT_REF" == "main" ]]; then
    # Check if the current HEAD matches what we already tested
    LAST_TESTED=$(jq -r ".components.$COMPONENT.last_tested // \"\"" "$WORKBENCH_DIR/manifest.json" 2>/dev/null || echo "")
    if [[ "$LAST_TESTED" == "$LATEST" ]]; then
        log "$COMPONENT: no new commits since last sweep, skipping"
    else
        # New commits found — test with harness-bench
        log "$COMPONENT: new commits found, running harness-bench"
        
        cd "$HARNESS_BENCH"
        LABEL="sweep-$COMPONENT-$(date -u +%Y%m%d)"
        
        # Run benchmark (use the component's latest)
        if run bin/bench run core --model "local" --label "$LABEL" 2>&1 | tee -a "$SWEEP_LOG"; then
            # Tests passed — update manifest
            log "$COMPONENT: tests passed, updating manifest"
            
            if [[ $DRY_RUN -eq 0 ]]; then
                # Update manifest.json with new last_tested
                python3 -c "
import json
with open('$WORKBENCH_DIR/manifest.json') as f:
    m = json.load(f)
m['components']['$COMPONENT']['last_tested'] = '$LATEST'
m['qualified'] = '$(date -u +%Y-%m-%d)'
with open('$WORKBENCH_DIR/manifest.json', 'w') as f:
    json.dump(m, f, indent=2)
"
                
                # Commit and push
                run git -C "$WORKBENCH_DIR" add manifest.json
                run git -C "$WORKBENCH_DIR" commit -m "sweep: $COMPONENT qualified at $LATEST"
                run git -C "$WORKBENCH_DIR" push
                log "$COMPONENT: published"
            fi
        else
            log "$COMPONENT: tests FAILED, not updating manifest"
            exit 1
        fi
    fi
fi

log "=== daily sweep complete ==="
