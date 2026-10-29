#!/bin/bash
# daily-sweep.sh: vet component repos, test, publish working upgrades
#
# Flow:
# 1. Check each pinned component for new commits since last sweep
# 2. If changes: test with harness-bench
# 3. If tests pass: update manifest.json to new ref
# 4. Publish: commit + push manifest change
# 5. Deploy: apply qualified manifest to live workspace (private auto-update)
# 6. If tests fail: leave manifest as-is, report
#
# Usage: ./nightly/daily-sweep.sh [--dry-run]

set -euo pipefail
WORKBENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS_BENCH="${HARNESS_BENCH:-$HOME/repos/harness-bench}"
SWEEP_LOG="$WORKBENCH_DIR/BENCH/sweep-$(date -u +%Y-%m-%d).log"
DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY_RUN=1; fi

log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$SWEEP_LOG"; }

# qualified <bench output> — a summary line with at least one pass (dry-run always qualifies).
qualified() {
    [[ $DRY_RUN -eq 1 ]] || { grep -q 'passed [0-9]*/' <<<"$1" && ! grep -q 'passed 0/' <<<"$1"; }
}

# inert_only <repo> <from> <to>: 0 iff every changed path is inert (docs/*.md, .beads/, .github/, LICENSE, README, CHANGELOG);
# non-zero for anything else (code, SKILL/AGENTS/GLOBAL-RULES .md), empty diff, or git errors.
inert_only() {
    local repo="$1" from="$2" to="$3"
    local paths
    paths=$(git -C "$repo" -c core.quotePath=false diff --no-renames --name-only "$from" "$to" 2>/dev/null) || return 1
    [[ -n "$paths" ]] || return 1
    while IFS= read -r p; do
        case "$p" in
            # allowlist, not *.md: in skills repos most .md (SKILL, GLOBAL-RULES, references/) IS behavior
            # exact names: in case globs * crosses /, so README* would match README-tools/run.py
            docs/*.md|.beads/*|.github/*) continue ;;
            LICENSE|LICENSE.md|LICENSE.txt|README|README.md|*/README.md|CHANGELOG|CHANGELOG.md) continue ;;
            *) return 1 ;;
        esac
    done <<< "$paths"
    return 0
}

run() {
    if [[ $DRY_RUN -eq 1 ]]; then
        echo "[dry-run] would run: $*"
    else
        "$@"
    fi
}

# Deploy the qualified manifest to the live workspace
# Reads each component from manifest.json and copies to its dest
apply_manifest() {
    local manifest="$WORKBENCH_DIR/manifest.json"
    log "=== deploying qualified manifest ==="

    # Deploy pi-extensions
    local ext_src="$WORKBENCH_DIR/pi/extensions"
    local ext_dest=$(jq -r '.components["pi-extensions"].dest' "$manifest")
    ext_dest=$(eval echo "$ext_dest")
    if [[ -d "$ext_src" ]]; then
        run mkdir -p "$ext_dest"
        run cp -f "$ext_src"/*.ts "$ext_dest/" 2>/dev/null || log "WARN: no .ts extensions to deploy"
        run cp -f "$ext_src"/*.json "$ext_dest/" 2>/dev/null || true
        log "deployed pi-extensions to $ext_dest"
    fi

    # Deploy skills
    local skills_ref=$(jq -r '.components.skills.ref' "$manifest")
    local skills_dest=$(jq -r '.components.skills.dest' "$manifest")
    skills_dest=$(eval echo "$skills_dest")
    local skills_workdir="$WORKBENCH_DIR/.sweep-skills"
    if [[ -d "$skills_workdir/.git" ]]; then
        run git -C "$skills_workdir" checkout "$skills_ref" 2>/dev/null || true
        run git -C "$skills_workdir" pull origin "$skills_ref" 2>/dev/null || true
        run mkdir -p "$skills_dest"
        run cp -rf "$skills_workdir/skills/"* "$skills_dest/" 2>/dev/null || log "WARN: no skills to deploy"
        log "deployed skills to $skills_dest"
    fi

    log "=== manifest deployment complete ==="
}

log "=== daily sweep start ==="

# Component to sweep: skills
COMPONENT="skills"
REPO=$(jq -r --arg c "$COMPONENT" ".components[\$c].repo" "$WORKBENCH_DIR/manifest.json")
CURRENT_REF=$(jq -r --arg c "$COMPONENT" ".components[\$c].ref" "$WORKBENCH_DIR/manifest.json")
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
    LAST_TESTED=$(jq -r --arg c "$COMPONENT" ".components[\$c].last_tested // \"\"" "$WORKBENCH_DIR/manifest.json" 2>/dev/null || echo "")
    if [[ "$LAST_TESTED" == "$LATEST" ]]; then
        log "$COMPONENT: no new commits since last sweep, skipping"
    else
        if inert_only "$COMPONENT_DIR" "$LAST_TESTED" "$LATEST"; then
            log "$COMPONENT: inert-only commits (docs/beads/CI), skipping re-bench"
        else
            # New commits found — test with harness-bench
            log "$COMPONENT: new commits found, running harness-bench"

            cd "$HARNESS_BENCH"
            LABEL="sweep-$COMPONENT-$(date -u +%Y%m%d)"

            # Run benchmark (use the component's latest)
            # bench exits 1 only on an infra fault, so a 0/N run would otherwise qualify and auto-deploy (wb-qiy).
            # ponytail: floor at >=1 pass; compare against the last qualified run's Wilson CI if regressions slip through.
            if out=$(run bin/bench run core --model "local-llm/local" --label "$LABEL" 2>&1 | tee -a "$SWEEP_LOG") && qualified "$out"; then
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

                    # Auto-deploy qualified manifest to live workspace
                    apply_manifest
                fi
            else
                log "$COMPONENT: tests FAILED, not updating manifest"
                exit 1
            fi
        fi
    fi
fi

log "=== daily sweep complete ==="
