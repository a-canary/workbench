#!/bin/bash
# Off-box test of the GPU job operator (v100-jobs.sh loop): no GPU, no sudo, no systemd.
# Fakes: nvidia-smi (VRAM = 4000 MiB base + 8000 per running job, of 32768), systemd-run (runs the job inline),
# systemctl (no-op). Seams under test: NVSMI (nvidia-smi command) and ADMIT_SETTLE (seconds to wait after an admit).
# Expect: ADMIT_PCT=80 -> 26214 MiB budget -> 1 running (12000+8000=20000 ok), 2 running (20000+8000=28000 no):
# never more than 2 jobs at once, all 3 jobs done, none failed, loop exits on its own.
set -u
here=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/q/ready"
fail() { echo "FAIL: $*"; echo "--- events.log"; cat "$T/q/events.log" 2>/dev/null; exit 1; }

# a real nvidia-smi must never be called: the operator has to go through $NVSMI
printf '#!/bin/sh\necho "real nvidia-smi called" >&2; exit 1\n' > "$T/bin/nvidia-smi"
cat > "$T/fake-nvsmi" <<EOF
#!/bin/bash
case "\$*" in *compute-apps*) exit 0 ;; esac
n=\$(ls -d "$T/q/running"/*/ 2>/dev/null | wc -l)
echo "\$(( 4000 + 8000 * n )), 32768, 50, Not Active, Not Active"
EOF
# systemd-run --wait ... bash run.sh  ->  drop the options, run the command in the cwd
cat > "$T/fake-systemd-run" <<'EOF'
#!/bin/bash
while [ $# -gt 0 ] && [ "$1" != bash ]; do shift; done
exec "$@"
EOF
chmod +x "$T/bin/nvidia-smi" "$T/fake-nvsmi" "$T/fake-systemd-run"

mk() { mkdir -p "$T/q/ready/$1"; printf 'sleep 3; exit 0\n' > "$T/q/ready/$1/run.sh"; echo 8000 > "$T/q/ready/$1/vram_mb"; }
mk 1-a-x; mk 1-b-x; mk 1-c-x

PATH="$T/bin:$PATH" V100_JOBS="$T/q" UNIT=vjoff GRACE=2 ADMIT_PCT=80 SHED_PCT=98 MAX_JOBS=4 \
  NVSMI="$T/fake-nvsmi" ADMIT_SETTLE=1 SYSTEMD_RUN="$T/fake-systemd-run" SYSTEMCTL=true JOBCTL=true \
  timeout 60 bash "$here/v100-jobs.sh" loop; rc=$?
[ "$rc" = 124 ] && fail "loop did not exit within 60 s"

ev=$T/q/events.log
[ "$(grep -c ' start ' "$ev")" = 3 ] || fail "expected 3 starts"
[ "$(grep -c ' done ' "$ev")" = 3 ] || fail "expected 3 done"
grep -q 'failed\|unreadable' "$ev" && fail "a job failed or the fake GPU was unreadable"
# max concurrency from the event order: +1 per start, -1 per done
max=$(awk '/ start /{c++; if(c>m)m=c} / done /{c--} END{print m+0}' "$ev")
[ "$max" = 2 ] || fail "max concurrent jobs = $max, want 2 (VRAM packing)"
echo PASS
