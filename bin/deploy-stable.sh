#!/bin/bash
# deploy-stable.sh: detect workbench manifest changes, test, deploy to private workspace
# Run via cron: 0 */6 * * * ~/repos/workbench/bin/deploy-stable.sh
#
# Flow:
# 1. Compare current manifest hash with last deployed hash
# 2. If changed: run harness-bench core suite
# 3. If tests pass: apply incremental update (skills, proxy config, pi config)
# 4. Record deploy state
# 5. If tests fail: log, do not deploy

set -euo pipefail

WORKBENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_STATE="/home/aaron/workbench-deploy-state.json"
HARNESS_BENCH="/home/aaron/repos/harness-bench"
LOG="/tmp/workbench-deploy-$(date -u +%Y-%m-%d).log"

log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }

# Get current manifest hash
current_hash=$(git -C "$WORKBENCH_DIR" rev-parse HEAD)

# Get last deployed hash
if [[ -f "$DEPLOY_STATE" ]]; then
    last_hash=$(jq -r '.lastDeployedManifest // empty' "$DEPLOY_STATE" 2>/dev/null || echo "")
else
    last_hash=""
    echo '{"lastDeployedManifest": null, "lastDeployTime": null, "lastBenchResult": null}' > "$DEPLOY_STATE"
fi

log "deploy-stable: current=$current_hash last=$last_hash"

if [[ "$current_hash" == "$last_hash" ]]; then
    log "no manifest change, skipping deploy"
    exit 0
fi

log "manifest changed, running harness-bench core suite..."

# Determine model from workbench config
MODEL_ID=$(jq -r '.providers.v100.models[0].id' "$WORKBENCH_DIR/pi/models.json" 2>/dev/null || echo "local")
BENCH_LABEL="deploy-$(date -u +%Y%m%d-%H%M%S)"

# Run harness-bench
set +e
cd "$HARNESS_BENCH"
bin/bench run core --model "v100/$MODEL_ID" --label "$BENCH_LABEL" > "$LOG.bench" 2>&1
bench_exit=$?
set -e

if [[ $bench_exit -ne 0 ]]; then
    log "harness-bench FAILED (exit $bench_exit), NOT deploying"
    log "bench output: $LOG.bench"
    # Record failure
    jq --arg hash "$current_hash" --arg time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
       '.lastCheck = {hash: $hash, time: $time, result: "bench_failed"}' \
       "$DEPLOY_STATE" > "$DEPLOY_STATE.tmp" && mv "$DEPLOY_STATE.tmp" "$DEPLOY_STATE"
    exit 1
fi

log "harness-bench passed, applying incremental update..."

# Incremental update: skills
# Use existing arc-skills checkout rather than cloning to /tmp (which is volatile)
SKILLS_REF=$(jq -r '.components.skills.ref' "$WORKBENCH_DIR/manifest.json")
if [[ -d ~/repos/arc-skills/.git ]]; then
  log "updating existing arc-skills to $SKILLS_REF"
  git -C ~/repos/arc-skills fetch origin "$SKILLS_REF" --depth 1 2>/dev/null || true
  git -C ~/repos/arc-skills checkout -q "origin/$SKILLS_REF" 2>/dev/null || true
else
  log "cloning arc-skills from workbench manifest"
  SKILLS_REPO=$(jq -r '.components.skills.repo' "$WORKBENCH_DIR/manifest.json")
  git clone --depth 1 --branch "$SKILLS_REF" "$SKILLS_REPO" ~/repos/arc-skills 2>/dev/null || true
fi
# Preserve symlink to local checkout (live updates) rather than hard copy
rm -rf ~/.pi/skills
ln -sfn ~/repos/arc-skills/skills ~/.pi/skills

# Incremental update: pi config
log "updating pi config"
# models.json is machine-specific (real keys, IPs, local aliases) — back up and preserve
if [[ -f ~/.pi/agent/models.json ]]; then
  cp ~/.pi/agent/models.json "~/.pi/agent/models.json.bak-$(date +%s)"
  log "  backed up local models.json"
fi
# Only deploy settings.json if template exists
if [[ -f "$WORKBENCH_DIR/pi/pi-settings.json" ]]; then
  cp "$WORKBENCH_DIR/pi/pi-settings.json" ~/.pi/settings.json
  log "  deployed settings.json"
else
  log "  no settings template, preserving local settings.json"
fi

# Incremental update: extensions
if [[ -d "$WORKBENCH_DIR/pi/extensions" ]]; then
    log "updating pi extensions"
    cp "$WORKBENCH_DIR/pi/extensions/"*.ts ~/.pi/agent/extensions/ 2>/dev/null || true
    cp "$WORKBENCH_DIR/pi/extensions/"*.json ~/.pi/agent/extensions/ 2>/dev/null || true
fi

# Record successful deploy
jq --arg hash "$current_hash" --arg time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg label "$BENCH_LABEL" \
   '.lastDeployedManifest = $hash | .lastDeployTime = $time | .lastBenchResult = $label | del(.lastCheck)' \
   "$DEPLOY_STATE" > "$DEPLOY_STATE.tmp" && mv "$DEPLOY_STATE.tmp" "$DEPLOY_STATE"

log "deploy complete: manifest=$current_hash bench=$BENCH_LABEL"
exit 0
