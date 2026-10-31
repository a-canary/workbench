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

# Phase 2: if still below 5GB freed, clean our own /tmp scratch dirs untouched for 2+ days
# (find -mtime +1 rounds down, so it matches >= 48h).
# NUL-delimited: an unquoted `for d in $dirs` split a name like 'claude-x *' and globbed
# the `*` against the caller's cwd, rm -rf'ing the project checkout (wb#73 review).
tmp_root=${DISK_GC_TMP:-/tmp}
tmp_root=${tmp_root%/}  # find prints root/name; a trailing slash made live_scratch root//name and the skip missed
live_scratch="$tmp_root/claude-$(id -u)"  # Claude Code's per-user scratch: mtime lags while in use
if [ "$freed_kb" -lt "$max_kb" ]; then
    while IFS= read -r -d '' d; do
        [ "$freed_kb" -ge "$max_kb" ] && break
        [ "$d" = "$live_scratch" ] && continue
        size_kb=$(du -sk -- "$d" 2>/dev/null | awk '{print $1}')
        rm -rf -- "$d" 2>/dev/null
        if [ -e "$d" ]; then log "SKIP $d (rm failed)"; continue; fi
        freed_kb=$((freed_kb + ${size_kb:-0}))
        log "Removed $d (~$((${size_kb:-0} / 1024))M), freed $((freed_kb / 1024))M so far"
    done < <(find "$tmp_root" -mindepth 1 -maxdepth 1 -type d -user "$(id -u)" \( -name 'arc-*' -o -name 'analysis-*' -o -name 'bench-*' -o -name 'claude-*' -o -name 'gpu-*' \) -mtime +1 -print0 2>/dev/null)
fi

# Phase 3: if still below 5GB freed, dangling docker build cache only (-a wiped every
# user's cache machine-wide, ignoring the cap)
if [ "$freed_kb" -lt "$max_kb" ]; then
    docker builder prune -f >> "$LOG" 2>&1
    log "Pruned dangling docker builder cache"
fi
freed=$((freed_kb / 1024 / 1024))

final_gb=$(df --output=avail / | tail -1 | tr -d ' ' | awk '{print int($1/1024/1024)}')
log "GC complete: freed ~${freed}G, now ${final_gb}G free"
