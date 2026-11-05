#!/usr/bin/env bash
# Discover locally-available signals for /director's first-run onboarding.
# Prints one line per fact: "<key>\t<value>". Never fails; missing signals
# print "-". The skill reads this table and uses it to suggest — never
# silently apply — binding defaults and repo/memory locations.

set -uo pipefail

emit() { printf '%s\t%s\n' "$1" "$2"; }

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
emit repo-root "$repo_root"

if [ -f "$repo_root/AGENTS.md" ]; then
  emit agents-md-exists yes
  if grep -q '^## Director bindings' "$repo_root/AGENTS.md" 2>/dev/null; then
    emit director-bindings-exist yes
  else
    emit director-bindings-exist no
  fi
else
  emit agents-md-exists no
  emit director-bindings-exist no
fi

remote_url="$(git -C "$repo_root" remote get-url origin 2>/dev/null || echo -)"
emit git-remote "$remote_url"

xdg_vault="${XDG_DATA_HOME:-$HOME/.local/share}/arc/vault"
if [ -d "$xdg_vault" ]; then
  emit vault-path "$xdg_vault"
elif [ -d "$HOME/vault" ]; then
  emit vault-path "$HOME/vault"
else
  emit vault-path -
fi

registry="$HOME/.config/arc/directors.json"
if [ -f "$registry" ]; then
  emit directors-registry "$registry"
  if grep -q "\"$repo_root\"" "$registry" 2>/dev/null; then
    emit repo-already-registered yes
  else
    emit repo-already-registered no
  fi
else
  emit directors-registry -
  emit repo-already-registered no
fi
