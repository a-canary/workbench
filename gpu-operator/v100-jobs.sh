#!/bin/bash
# v100-jobs -- lend the idle GPU to batch jobs, Colab/Kaggle style: preemptible, packed by VRAM.
#
#   v100-jobs.sh idle   idle tick (reset-watch on home-lab-1). exit 0: runner active / started (it
#                       stops llama, runs jobs, restarts llama). exit 1: no job, llama (re)started
#                       if it was down -- a stranded llama heals on the next idle tick.
#   v100-jobs.sh busy   laneproxy-boxes --box-busy. Preempt every job (SIGTERM, GRACE s, then SIGKILL),
#                       make sure llama is up again.
#   v100-jobs.sh loop   the job operator itself (runs inside the v100-jobs systemd unit).
#
# A job is a directory with run.sh in $Q/ready/. Jobs start in name order (glob sort), output appended to
# job.log. exit 0 -> done/, preempted or shed -> back to ready/ (run.sh runs again from the top: checkpoint
# on SIGTERM to resume), anything else -> failed/.
# Submit atomically: copy to ready/.NAME (hidden, ignored), then mv to ready/NAME.
# Priority = name prefix (lexical order, arc-sl5.3): 1-ndiv-*, then 2-trading-*, then 3-rnd-*.
# 3-rnd-* jobs (public R&D, repos-p1qw) run as user v100job from $V100JOB_WORK/NAME (payload dir).
#
# Packing (operator 11-18): several jobs share the GPU. Each job runs in its own transient unit
# vj-$UNIT-NAME, so it can be stopped and its VRAM attributed on its own.
#   VRAM need: ready/NAME/vram_mb if present, else the peak last measured for its class (NAME minus its
#   last -token, in $Q/vram-peaks), else VRAM_DEFAULT_MB.
#   Admit the next job while used + need <= ADMIT_PCT of total, GPU temp < TEMP_MAX, no thermal
#   slowdown, and fewer than MAX_JOBS run. A blocked head job blocks the queue (no skipping: priority holds).
#   Shed: used > SHED_PCT of total -> stop the newest job, requeue it. Pausing would not free its VRAM.
#   GPU: index of the card this operator owns (one operator per GPU; Kaggle T4x2 runs two, distinct UNIT/Q).
# touch $Q/PAUSE: no new job starts and an idle/busy hook never starts llama. Running jobs finish
# (or are preempted), then the runner restores llama.
# $Q/DRAIN: no new job starts, running jobs finish unpreempted, then the runner exits and starts llama.
set -u
Q=${V100_JOBS:-$HOME/v100-jobs}
GRACE=${GRACE:-60}
LLAMA=${LLAMA:-llama-qwen}
UNIT=${UNIT:-v100-jobs}
GPU=${GPU:-0}
MAX_JOBS=${MAX_JOBS:-4}
ADMIT_PCT=${ADMIT_PCT:-80}
SHED_PCT=${SHED_PCT:-98}
TEMP_MAX=${TEMP_MAX:-80}
VRAM_DEFAULT_MB=${VRAM_DEFAULT_MB:-8192}
SYSTEMCTL=${SYSTEMCTL:-sudo -n systemctl}      # llama control (tests override with true)
JOBCTL=${JOBCTL:-sudo -n systemctl}            # job unit control
SYSTEMD_RUN=${SYSTEMD_RUN:-sudo -n systemd-run}
V100JOB_SUDO=${V100JOB_SUDO:-sudo -n -u v100job}
V100JOB_WORK=${V100JOB_WORK:-/var/lib/v100job/work}
V100JOB_USER=${V100JOB_USER:-v100job}   # owner of escaped job processes that may still hold the GPU
mkdir -p "$Q/ready" "$Q/running" "$Q/done" "$Q/failed"
ACTIVE="${SYSTEMCTL_RO:-systemctl} -q is-active"   # read-only: no sudo, so no auth-log line every 15 s
log() { echo "$(date -Is) $*" >> "$Q/events.log"; }
next() { for d in "$Q"/ready/*/; do [ -f "$d/run.sh" ] && { basename "$d"; return; }; done; return 1; }
ju() { echo "vj-$UNIT-$1"; }
stopall() { $JOBCTL stop "vj-$UNIT-*" 2>/dev/null; }   # glob: every job unit of this operator

case "${1:-}" in
idle)
  $ACTIVE "$UNIT" && exit 0
  stopall   # runner gone (box reset, SIGKILL): its job units must not keep holding the GPU
  # runner gone but its jobs still in running/: they died with the runner; owner decides on resubmit (repos-rhv6f)
  # keep the plain name so v100-spool-sync collects it and v100idle frees the spool slot (a renamed dir held the slot
  # up to 48 h, 11-18); suffix only when failed/ already holds the name (requeued then failed again); mv -T never nests
  for d in "$Q"/running/*/; do [ -d "$d" ] || continue; n=$(basename "$d"); dst="$Q/failed/$n"; [ -e "$dst" ] && dst="$dst.stranded-$(date +%s)"
    log "stranded $n (runner gone, e.g. box reset) -> failed/${dst##*/}"
    mv -T "$d" "$dst" && echo "runner gone (box reset)" > "$dst/STRANDED" || log "stranded $n: mv failed, left in running/"; done
  [ -e "$Q/PAUSE" ] && exit 1
  [ -e "$Q/DRAIN" ] && { $ACTIVE "$LLAMA" || { log "idle: drain, $LLAMA was down, starting"; $SYSTEMCTL start "$LLAMA"; }; exit 1; }
  next >/dev/null || { $ACTIVE "$LLAMA" || { log "idle: $LLAMA was down, starting"; $SYSTEMCTL start "$LLAMA"; }; exit 1; }
  log "idle: starting runner"
  # --collect: a failed/killed runner must not leave the unit name taken (next idle would fail).
  env_args=(); for v in V100_JOBS=$Q GRACE LLAMA UNIT GPU MAX_JOBS ADMIT_PCT SHED_PCT TEMP_MAX VRAM_DEFAULT_MB \
    V100JOB_SUDO V100JOB_WORK V100JOB_USER SYSTEMCTL JOBCTL; do case $v in *=*) env_args+=(--setenv="$v") ;; *) env_args+=(--setenv="$v=${!v}") ;; esac; done
  $SYSTEMD_RUN -q --collect --unit="$UNIT" --uid="$(id -u)" --gid="$(id -g)" --setenv=HOME="$HOME" "${env_args[@]}" \
    -p TimeoutStopSec=$((GRACE + 60)) -p KillMode=mixed "$(readlink -f "$0")" loop
  ;;
busy)
  if $ACTIVE "$UNIT"; then log "busy: preempting"; $JOBCTL stop "$UNIT"; fi
  # Paused: llama up only if the preempted runner restored it (then laneproxy waits for /health);
  # nonzero = llama stays down, laneproxy skips the wait.
  [ -e "$Q/PAUSE" ] && { $ACTIVE "$LLAMA"; exit; }
  $SYSTEMCTL start "$LLAMA"
  ;;
loop)
  stop=0
  trap 'stop=1' TERM
  nap() { sleep "$1" & wait $!; }   # wait, unlike a foreground sleep, returns at once on TERM
  declare -A peak=()   # job -> max MiB seen
  for d in "$Q"/running/*/; do [ -d "$d" ] && mv "$d" "$Q/ready/" && log "recovered $(basename "$d")"; done
  $SYSTEMCTL stop "$LLAMA" || { log "could not stop $LLAMA, no jobs run"; exit 1; }
  cls() { echo "${1%-*}"; }
  need() { local f=$Q/ready/$1/vram_mb p
    [ -s "$f" ] && { tr -dc 0-9 < "$f"; return; }
    p=$(awk -v c="$(cls "$1")" '$1==c{v=$2} END{print v}' "$Q/vram-peaks" 2>/dev/null)
    echo "${p:-$VRAM_DEFAULT_MB}"; }
  gpu() { timeout 10 nvidia-smi -i "$GPU" --query-gpu=memory.used,memory.total,temperature.gpu,clocks_throttle_reasons.hw_thermal_slowdown,clocks_throttle_reasons.sw_thermal_slowdown --format=csv,noheader,nounits | tr -d ' '; }
  running() { local d; for d in "$Q"/running/*/; do [ -d "$d" ] && basename "$d"; done; }
  start() { local j=$1 u wd; u=$(ju "$j")
    mv "$Q/ready/$j" "$Q/running/$j"; log "start $j (need $(cat "$Q/running/$j/.need") MiB)"
    if [[ $j == 3-rnd-* ]]; then ua=(--uid="$V100JOB_USER"); wd=$V100JOB_WORK/$j; else ua=(--uid="$(id -u)" --gid="$(id -g)"); wd=$Q/running/$j; fi
    ( cd "$Q/running/$j" && $SYSTEMD_RUN -q --wait --pipe --collect --unit="$u" "${ua[@]}" -p WorkingDirectory="$wd" \
        --setenv=HOME="$HOME" --setenv=CUDA_VISIBLE_DEVICES="$GPU" -p KillMode=control-group -p TimeoutStopSec="$GRACE" \
        bash run.sh >> job.log 2>&1 < /dev/null; echo $? > .rc.tmp && mv .rc.tmp .rc ) &
  }
  requeue() { local j=$1; $JOBCTL stop "$(ju "$j")" 2>/dev/null
    for _ in $(seq 50); do [ -f "$Q/running/$j/.rc" ] && break; sleep 0.2; done
    rm -f "$Q/running/$j/.rc" "$Q/running/$j/.need"; mv "$Q/running/$j" "$Q/ready/$j"; log "$2 $j (requeued)"; }
  record() { [ -n "${peak[$1]:-}" ] && echo "$(cls "$1") ${peak[$1]}" >> "$Q/vram-peaks"; unset "peak[$1]"; }
  while :; do
    # reap finished jobs
    for j in $(running); do f=$Q/running/$j/.rc; [ -f "$f" ] || continue; rc=$(cat "$f"); rm -f "$f" "$Q/running/$j/.need"
      if [ "$rc" = 0 ]; then mv "$Q/running/$j" "$Q/done/$j"; log "done $j peak=${peak[$j]:-?} MiB"; else mv "$Q/running/$j" "$Q/failed/$j"; log "failed $j rc=$rc"; fi
      record "$j"
    done
    # no record on preempt: an early stop (venv build, ~1 min) logged 510 MiB as the class peak, 11-18
    if [ "$stop" = 1 ]; then for j in $(running); do unset "peak[$j]"; requeue "$j" preempted; done; break; fi
    IFS=, read -r used total temp hwt swt <<<"$(gpu)"
    # attribute VRAM to jobs: compute pid -> its vj- unit via cgroup
    while IFS=, read -r pid mb; do
      u=$(grep -o "vj-$UNIT-[^/]*\.service" /proc/"${pid// /}"/cgroup 2>/dev/null | head -1); [ -n "$u" ] || continue
      j=${u#vj-$UNIT-}; j=${j%.service}; mb=${mb// /}; [ "$mb" -gt "${peak[$j]:-0}" ] && peak[$j]=$mb
    done < <(timeout 10 nvidia-smi -i "$GPU" --query-compute-apps=pid,used_memory --format=csv,noheader,nounits 2>/dev/null)
    run=($(running)); n=${#run[@]}
    if [[ $used =~ ^[0-9]+$ && $total =~ ^[0-9]+$ ]]; then
      if [ $((used * 100)) -gt $((total * SHED_PCT)) ] && [ "$n" -gt 1 ]; then
        newest=$(ls -td "$Q"/running/*/ | head -1); newest=$(basename "$newest"); record "$newest"; requeue "$newest" "shed (used ${used}/${total} MiB)"; continue
      fi
      if [ ! -e "$Q/PAUSE" ] && [ ! -e "$Q/DRAIN" ] && [ "$n" -lt "$MAX_JOBS" ] && j=$(next); then
        nd=$(need "$j"); hot=0; [ "${temp:-0}" -ge "$TEMP_MAX" ] || [[ $hwt == Active || $swt == Active ]] && hot=1
        if [ "$hot" = 0 ] && { [ "$n" = 0 ] || [ $(( (used + nd) * 100 )) -le $((total * ADMIT_PCT)) ]; }; then
          echo "$nd" > "$Q/ready/$j/.need"; start "$j"; nap 15; continue   # let it allocate before the next decision
        fi
      fi
    else log "nvidia-smi unreadable: '$used,$total'"; fi
    [ "$n" = 0 ] && { [ -e "$Q/PAUSE" ] || [ -e "$Q/DRAIN" ] || ! next >/dev/null; } && break
    nap 5
  done
  jobgpu() { local p; for p in $(timeout 5 nvidia-smi -i "$GPU" --query-compute-apps=pid --format=csv,noheader 2>/dev/null); do grep -q "vj-$UNIT-" /proc/"$p"/cgroup 2>/dev/null && return 0; done; return 1; }
  held=1; end=$((SECONDS+30)); while [ $SECONDS -lt $end ]; do jobgpu || { held=0; break; }; sleep 1; done
  [ "$held" = 1 ] && { log "gpu still held by job units after 30s, stopping them"; stopall; }
  $SYSTEMCTL start "$LLAMA"; log "runner exit, $LLAMA started"
  ;;
*) echo "usage: $0 idle|busy|loop"; exit 2 ;;
esac
