#!/usr/bin/env bash
# Postiz discoverability gate. Mirrors director/discover-setup.sh.
# The Postiz agent CLI is OFF by default. It becomes available ONLY when the
# current project's AGENTS.md or CHOICES.md declares a "## Postiz" section.
# Prints one line per fact: "<key>\t<value>". Never fails; missing -> "-".
#
#   enabled       yes|no   -> the deciding fact; the skill hard-stops on "no"
#   declared-in   <path>|- -> which project file opted in
#   api-url       <url>|-  -> POSTIZ_API_URL to target (from the section or default)
#   cli-present   yes|no   -> `postiz` binary on PATH
#   host-up       yes|no   -> self-hosted Postiz answering on api-url

set -uo pipefail
emit() { printf '%s\t%s\n' "$1" "$2"; }

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
emit repo-root "$repo_root"

# ponytail: grep two known files, not a walk. Projects declare in AGENTS.md or CHOICES.md;
# extend the list on the first legit declaration elsewhere (false NO_DECLARATION block).
declared_in="-"
for f in "$repo_root/AGENTS.md" "$repo_root/CHOICES.md"; do
  [ -f "$f" ] || continue
  if grep -qiE '^##[[:space:]]+Postiz\b' "$f" 2>/dev/null; then declared_in="$f"; break; fi
done

if [ "$declared_in" = "-" ]; then
  emit enabled no
  emit declared-in -
  emit api-url -
  emit cli-present -
  emit host-up -
  exit 0
fi

emit enabled yes
emit declared-in "$declared_in"

# api-url: an `api-url: <x>` line inside the declaration wins, else the default host.
api_url="$(grep -ioP '^\s*api-url:\s*\K\S+' "$declared_in" 2>/dev/null | head -1)"
api_url="${api_url:-http://localhost:4007}"
emit api-url "$api_url"

if command -v postiz >/dev/null 2>&1; then emit cli-present yes; else emit cli-present no; fi

if curl -fsS --max-time 4 "$api_url" >/dev/null 2>&1; then emit host-up yes; else emit host-up no; fi
