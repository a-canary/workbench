#!/usr/bin/env bash
# Discover which model providers are reachable on this machine.
# Prints one line per provider: "<provider>\t<source>\t<status>"
#   source = env:<VAR> | pass:<path>
#   status = ok (key present) | missing
# Exit 0 always; the skill reads the table and decides.

set -uo pipefail

emit() { printf '%s\t%s\t%s\n' "$1" "$2" "$3"; }

# Map provider -> candidate env var(s) and pass path. Keep this list in sync
# with the aliases the skill knows how to build.
check_env() {
  local provider="$1"; shift
  local var
  for var in "$@"; do
    if [ -n "${!var:-}" ]; then emit "$provider" "env:$var" ok; return 0; fi
  done
  return 1
}

check_pass() {
  local provider="$1" path="$2"
  command -v pass >/dev/null 2>&1 || return 1
  if pass show "$path" >/dev/null 2>&1; then emit "$provider" "pass:$path" ok; return 0; fi
  return 1
}

# anthropic / claude — either a direct API key, an OAuth token, or the
# logged-in `claude` CLI (subscription auth, no key needed).
if ! check_env anthropic ANTHROPIC_API_KEY; then
  if ! check_pass anthropic api/anthropic/api-key; then
    if check_pass anthropic api/claude/oauth-token; then :;
    elif command -v claude >/dev/null 2>&1; then emit anthropic cli:claude ok;
    else emit anthropic - missing; fi
  fi
fi

check_env minimax    MINIMAX_API_KEY   || check_pass minimax    api/minimax/api-key    || emit minimax    - missing
check_env openrouter OPENROUTER_API_KEY || check_pass openrouter api/openrouter/api-key || emit openrouter - missing
check_env chutes     CHUTES_API_KEY    || check_pass chutes     api/chutes/api-key     || emit chutes     - missing
