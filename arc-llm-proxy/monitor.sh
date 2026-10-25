#!/usr/bin/env bash
# GPU host + arc-llm-proxy monitor
# polls every 30s; logs to /var/tmp/gpu-monitor.log; rotates daily
set -u

LOG_FILE=${LOG_FILE:-/var/tmp/gpu-monitor.log}
PROXY=${PROXY:-http://localhost:8091}
GPU_HOST=${GPU_HOST:?set GPU_HOST to the llama-server host (ssh target)}
GPU_USER=${GPU_USER:-$USER}
GPU_PASS_FILE=${GPU_PASS_FILE:-$HOME/.ssh-tmp/gpu-host}
FACTORY_KEY=${FACTORY_KEY:?set FACTORY_KEY to a proxy key from deploy/keys.*.json}

mkdir -p /var/tmp
touch "$LOG_FILE"

# rotate at 10 MB
if [ -f "$LOG_FILE" ] && [ $(stat -c%s "$LOG_FILE") -gt 10485760 ]; then
  mv "$LOG_FILE" "${LOG_FILE}.$(date +%Y%m%d-%H%M%S).old"
  : > "$LOG_FILE"
fi

run_ssh() {
  sshpass -f "$GPU_PASS_FILE" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 \
    -o LogLevel=ERROR "$GPU_USER@$GPU_HOST" "$1" 2>/dev/null
}

echo "[$(date -u +%FT%TZ)] monitor starting (pid=$$)" >> "$LOG_FILE"

while true; do
  TS=$(date -u +%FT%TZ)
  # Proxy health + queue
  HEALTH=$(curl -s -m 3 "$PROXY/health" 2>/dev/null)
  QUEUE=$(curl -s -m 3 -H "Authorization: Bearer $FACTORY_KEY" "$PROXY/__queue" 2>/dev/null)
  # GPU host VRAM/GPU
  NVIDIA=$(run_ssh "nvidia-smi --query-gpu=memory.used,utilization.gpu,temperature.gpu,power.draw --format=csv,noheader" 2>&1 | head -1)
  # llama-server alive?
  SRV=$(run_ssh "pgrep -c -x llama-server 2>/dev/null" 2>&1 | head -1)
  # last 3 audit entries
  AUDIT=$(tail -3 ${AUDIT_FILE:-$HOME/repos/arc-llm-proxy/deploy/audit.jsonl} 2>/dev/null | tr '\n' '|')
  printf '%s | srv=%s | vram=%s | queue=%s | audit_tail=%s\n' \
    "$TS" "$SRV" "$NVIDIA" "$(echo $QUEUE | head -c 200)" "${AUDIT:0:300}" \
    >> "$LOG_FILE"
  sleep 30
done
