#!/usr/bin/env bash
# PreToolUse hook — write-lane gate (DESIGN.md invariant 7, §4.3 rung 2).
# Reads Claude tool-call JSON on stdin, extracts file-write targets, and runs
# the ONE shared check (src/policy/check.ts). Exit 2 blocks the tool call and
# feeds the allowlist error back to the model.
#
# Coverage: file tools (Write/Edit/MultiEdit/NotebookEdit) are fully gated;
# Bash is gated for redirections (> / >>), tee, and write-verb destinations
# (cp/mv/ln/rsync last arg and -t target, dd of=, curl/wget -o). Interpreter-based writes
# (python open(...), sed -i scripts, node -e) are NOT detectable at the regex
# layer. That residual risk is closed at the merge-gate path, which runs the same
# check over the PR diff file list (what actually landed).
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LEDGER_DB="${LEDGER_DB:-$HOME/vault/ledger.db}"

input="$(cat)"
tool="$(printf '%s' "$input" | jq -r '.tool_name // empty')"
[ -z "$tool" ] && exit 0

paths=""
case "$tool" in
  Write|Edit|MultiEdit)
    paths="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')"
    ;;
  NotebookEdit)
    paths="$(printf '%s' "$input" | jq -r '.tool_input.notebook_path // empty')"
    ;;
  Bash)
    cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty')"
    if [ -n "$cmd" ]; then
      # output redirections: > path, >> path, >| path, and explicit-fd forms
      # (1> path). fd dups like 2>&1 still don't match: `&` is not in the target
      # char class, so there is nothing to extract.
      # An opening quote is stepped over — `> "$HOME/bin/a"` is the common way an
      # out-of-lane target arrives, and skipping it made the gate fail OPEN.
      # `{}()` and backtick stay IN the class so `${HOME}/bin/a` and
      # `$(...)/bin/a` reach the check and are rejected there as unresolvable;
      # dropping them extracted a bare `$` instead, which resolved clean.
      redir="$(printf '%s' "$cmd" \
        | grep -oE '(^|[[:space:];|&(])[0-9]?>>?\|?[[:space:]]*"?'"'"'?[~$`(){}A-Za-z0-9_./-]+' \
        | sed -E 's/^[[:space:];|&()]*[0-9]?>>?\|?[[:space:]]*["'"'"']?//')"
      # tee [ -a ] path... — an opening quote is stepped over, same as redirects:
      # the old char class excluded `"`, so a quoted destination extracted nothing.
      teed="$(printf '%s' "$cmd" \
        | grep -oE '\btee[[:space:]]+(-a[[:space:]]+)?"?'"'"'?[^[:space:];|&<>"'"'"']+' \
        | sed -E 's/^tee[[:space:]]+//; s/^-a[[:space:]]+//; s/^["'"'"']//')"
      # write-verb destinations (last arg of cp/mv/ln/rsync, plus -t/--target-directory;
      # dd of=; curl/wget -o). Every quote char is stripped (`"$D"/x`, an
      # unterminated `"$D/x` would otherwise resolve against cwd); an empty
      # result (`cp a ""`) becomes `.` so it is checked against cwd, not skipped.
      # Redirect tokens (`2>/e`, `>>x`, `2>&1`) are dropped first so `mv a b 2>/e`
      # still ends in `b`; `redir=` above gates the redirect targets themselves.
      # Regex layer: quoted decoys (echo "cp a ~/bin/x") fail closed — acceptable.
      verbs="$(printf '%s' "$cmd" \
        | sed -E 's/(^|[[:space:]])[0-9]*>>?[&|]?[[:space:]]*[^[:space:];|&<>]*//g' \
        | grep -oE '\b(cp|mv|ln|rsync)\b[^;|&<>]*' \
        | awk '{ n = split($0, a, /[[:space:]]+/); if (a[n] == "") n--
                 # -t is a target dir for cp/mv/ln only (rsync -t = preserve times):
                 # -t D, -rt D, -tD, -rtD, --target-directory D, --t=D (any long prefix)
                 if (a[1] != "rsync") for (i = 2; i <= n; i++) {
                   if (a[i] ~ /^(-[A-Za-z]*t|--t[a-z-]*)$/ && i < n) print a[i + 1]
                   else if (a[i] ~ /^--t[a-z-]*=/) print substr(a[i], index(a[i], "=") + 1)
                   else if (a[i] ~ /^-[A-Za-z]*t./) print substr(a[i], index(a[i], "t") + 1)
                 }
                 print a[n] }' \
        | sed -E "s/[\"']//g; s/^\$/./")"
      # of= and -o destinations: an opening quote is stepped over here too —
      # the old classes excluded it, so a quoted destination extracted nothing.
      ofargs="$(printf '%s' "$cmd" \
        | grep -oE '\bof="?'"'"'?[^[:space:];|&<>"'"'"']+' \
        | sed -E 's/^of=["'"'"']?//')"
      outargs="$(printf '%s' "$cmd" \
        | grep -oE '\-o[[:space:]]+"?'"'"'?[^[:space:];|&<>"'"'"']+' \
        | sed -E 's/^-o[[:space:]]+["'"'"']?//')"
      paths="$(printf '%s\n%s\n%s\n%s\n%s' "$redir" "$teed" "$verbs" "$ofargs" "$outargs")"
    fi
    ;;
  *)
    exit 0
    ;;
esac

# bun is not on cron/hook PATH (login shells get it via ~/.bashrc). Resolve it
# explicitly; a missing runtime must fail CLOSED — this is a write-lane gate, so
# "cannot check" is never "allow".
BUN="$(command -v bun || true)"
[ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ] && BUN="$HOME/.bun/bin/bun"
if [ -z "$BUN" ]; then
  printf 'pre-write-lane: bun not found (looked on PATH and %s/.bun/bin/bun); refusing the write\n' "$HOME" >&2
  exit 2
fi

status=0
while IFS= read -r p; do
  [ -z "$p" ] && continue
  # the null device is the only true discard: never a filesystem write.
  # fd-backed device paths (/dev/fd/N, /dev/stdout, /dev/stderr) are NOT
  # exempt — they resolve through /proc/self/fd to whatever the fd points at.
  case "$p" in /dev/null) continue ;; esac
  if ! out="$("$BUN" "$REPO/src/policy/check.ts" --db "$LEDGER_DB" "$p" 2>&1)"; then
    printf '%s\n' "$out" >&2
    status=2
  fi
done <<< "$paths"

exit "$status"
