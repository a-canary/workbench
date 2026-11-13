# startup crash detection (infra vs model failure). Sourced by worker-task and lead-check.
# the sandbox masks .git and has no docker or network to a local DB (wb-igh: a merge-gate Test died with
# "not a git repository" and was taken as a valid RED). Sets $crash to the matched pattern (our own constant,
# never test output: GREEN output is worker-controlled and WORKER_TASK_LOG reaches beads).
crash_pats=('EROFS: read-only file system' 'failed to load config' 'Startup Error')
# RED-only: a missing git/docker/DB is fixed before any worker runs, so once RED ran clean a GREEN that
# prints one of these is the worker's own output (or doing) and stays the model's failure, not infra.
red_pats=('fatal: not a git repository' 'docker: (command )?not found' 'Cannot connect to the Docker daemon'
  'ECONNREFUSED 127\.0\.0\.1:5432' 'connect ECONNREFUSED .*:5432' 'This does not look like a tar archive')
crash=
startup_crash() { # $1 output file; $2=red also matches red_pats
  local p; for p in "${crash_pats[@]}" ${2:+"${red_pats[@]}"}; do grep -qE -- "$p" "$1" && { crash=$p; return 0; }; done; return 1
}
