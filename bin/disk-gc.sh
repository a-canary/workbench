#!/bin/bash
# disk-gc.sh — free UP TO 5GB when triggered. Called by disk-guard extension
# when free space drops below 1GB. Never cleans more than needed (max 5GB).
# Primary target: ~/trash (oldest first). Fallback: /tmp scratch, docker cache.

set -uo pipefail
LOG="$HOME/.cache/arc-hygiene/disk-gc.log"
MAX_FREE_GB=5
mkdir -p "$(dirname "$LOG")" 2>/dev/null

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG" 2>/dev/null; }

# One instance at a time: disk-guard's execSync timeout kills the sh wrapper but
# orphans this script, so re-triggers stacked 11 concurrent copies (2026-10-24).
exec 9>"$LOG.lock"; flock -n 9 || exit 0

freed_kb=0
max_kb=$((MAX_FREE_GB * 1024 * 1024))
log "GC triggered"

# Phase 1: empty ~/trash oldest-first, up to 5GB total. Walk the list once: an
# item rm can't remove (root-owned files from a container build) used to be
# re-picked forever, logging 59M lines (2026-10-24/25). Count KB, not whole GB:
# sub-GB items rounded to 0 and never advanced the budget.
while IFS= read -r item; do
    [ "$freed_kb" -ge "$max_kb" ] && break
    case "$item" in ""|.|..) continue ;; esac  # newline-split names must never resolve to ~/trash or above
    item_kb=$(du -sk ~/trash/"$item" 2>/dev/null | awk '{print $1}')
    rm -rf ~/trash/"$item" 2>/dev/null
    if [ -e ~/trash/"$item" ]; then
        log "SKIP ~/trash/$item (rm failed; needs root)"
        continue
    fi
    freed_kb=$((freed_kb + ${item_kb:-0}))
    log "Removed ~/trash/$item (~$((${item_kb:-0} / 1024))M), freed $((freed_kb / 1024))M so far"
done < <(ls -1tr ~/trash 2>/dev/null)
freed=$((freed_kb / 1024 / 1024))

# Phase 2: if still below 5GB freed, clean /tmp scratch dirs older than 1 day
if [ "$freed" -lt "$MAX_FREE_GB" ]; then
    tmp_dirs=$(find /tmp -maxdepth 1 -type d \( -name 'arc-*' -o -name 'analysis-*' -o -name 'bench-*' -o -name 'claude-*' -o -name 'gpu-*' \) -mtime +1 2>/dev/null)
    for d in $tmp_dirs; do
        [ "$freed" -ge "$MAX_FREE_GB" ] && break
        size_kb=$(du -sk "$d" 2>/dev/null | awk '{print $1}')
        rm -rf "$d" 2>/dev/null
        size_gb=$(( ${size_kb:-0} / 1024 / 1024 ))
        freed=$((freed + size_gb))
        log "Removed $d (~${size_gb}G)"
    done
fi

# Phase 3: if still below 5GB freed, docker builder cache
if [ "$freed" -lt "$MAX_FREE_GB" ]; then
    docker builder prune -af 2>/dev/null >> "$LOG" 2>&1
    log "Pruned docker builder cache"
fi

final_gb=$(df --output=avail / | tail -1 | tr -d ' ' | awk '{print int($1/1024/1024)}')
log "GC complete: freed ~${freed}G, now ${final_gb}G free"
