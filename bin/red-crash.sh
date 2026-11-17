# startup crash detection (infra vs model failure). Sourced by worker-task and lead-check.
# the sandbox masks .git and has no docker or network to a local DB (wb-igh: a merge-gate Test died with
# "not a git repository" and was taken as a valid RED). Sets $crash to the matched pattern (our own constant,
# never test output: GREEN output is worker-controlled and WORKER_TASK_LOG reaches beads).
crash_pats=('EROFS: read-only file system' 'failed to load config' 'Startup Error')
# RED-only: a missing git/docker/DB is fixed before any worker runs, so once RED ran clean a GREEN that
# prints one of these is the worker's own output (or doing) and stays the model's failure, not infra.
# The test runner itself is absent from the jail (repos-v5j7: pytest in the host's ~/.local, which the jail masks).
# `python -m X` names the interpreter, an import inside a test says ModuleNotFoundError; a bare command name is a
# tool, a path with a slash may be a script the worker is to write.
runner_pat='^[^ ]*python[0-9.]*: No module named |^(sh|bash|dash): ((line )?[0-9]+: )?[^/ :]+: (command )?not found'
red_pats=('fatal: not a git repository' 'docker: (command )?not found' 'Cannot connect to the Docker daemon'
  'ECONNREFUSED 127\.0\.0\.1:5432' 'connect ECONNREFUSED .*:5432' 'This does not look like a tar archive' "$runner_pat")
crash=
startup_crash() { # $1 output file; $2=red also matches red_pats
  # a passing test may print an infra pattern as its own case name (repos-uxhm): filter out
  # the runner's passing-report lines before matching
  local p; for p in "${crash_pats[@]}" ${2:+"${red_pats[@]}"}; do
    # process substitution, not a pipe: under the callers' pipefail grep -q's early exit would SIGPIPE the filter
    grep -qE -- "$p" < <(grep -avE '^[[:space:]]*(PASS|\(pass\)|ok |✓)' "$1") && { crash=$p; return 0; }
  done; return 1
}
