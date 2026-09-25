#!/usr/bin/env bash
# Register the picked fast/smart aliases inside arc-agents/config.json.
#
# Usage: write-config.sh <fast-alias-name> <fast-cmd> <smart-alias-name> <smart-cmd>
#   alias-name = short kebab-case identifier (e.g. minimax-fast, opus-max)
#   cmd        = full CLI template containing {prompt} exactly once
#
# Side effects on arc-agents/config.json (default ~/repos/arc-agents/config.json,
# override via $ARC_AGENTS_CONFIG):
#   - merges {<fast-alias-name>: <fast-cmd>, <smart-alias-name>: <smart-cmd>} into
#     exec_cli_alias (existing entries with the same name are overwritten)
#   - sets top-level "fast_alias" = <fast-alias-name>
#   - sets top-level "smart_alias" = <smart-alias-name>
#
# Pre-validates both templates client-side (same rules as the arc-agents Zod
# schema -- {prompt} exactly once; `claude --model X` only when X in
# {opus, sonnet, haiku}) so a bad pick never corrupts the consumer config:
# arc-agents loadConfig enforces these too, but failing here gives a clear
# shell error instead of leaving a half-rewritten file for the next bun
# process to crash on.

set -euo pipefail

fast_alias="${1:?fast-alias-name}"; fast_cmd="${2:?fast cmd}"
smart_alias="${3:?smart-alias-name}"; smart_cmd="${4:?smart cmd}"

cfg="${ARC_AGENTS_CONFIG:-$HOME/repos/arc-agents/config.json}"
[ -f "$cfg" ] || { echo "write-config: arc-agents config not found at $cfg (set ARC_AGENTS_CONFIG to override)" >&2; exit 2; }

validate_template() {
  local name="$1" cmd="$2" n claude_model
  n="$(grep -o '{prompt}' <<<"$cmd" | wc -l)"
  [ "$n" = 1 ] || { echo "write-config: alias '$name' must contain {prompt} exactly once (found $n): $cmd" >&2; exit 2; }
  if [[ "$cmd" =~ ^claude[[:space:]] ]]; then
    claude_model="$(grep -oP -- '--model[= ]+\K\S+' <<<"$cmd" | head -1)"
    case "$claude_model" in
      opus|sonnet|haiku|fable) : ;;
      "") echo "write-config: alias '$name' invokes claude but is missing --model" >&2; exit 2 ;;
      *) echo "write-config: alias '$name' uses 'claude --model $claude_model'; only opus|sonnet|haiku|fable allowed (must match arc-agents CLAUDE_MODELS). Route provider models via 'pi -p --provider ...'" >&2; exit 2 ;;
    esac
  fi
}

validate_template "$fast_alias" "$fast_cmd"
validate_template "$smart_alias" "$smart_cmd"

dir="$(dirname "$cfg")"
tmp="$(mktemp "$dir/.config.json.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

jq \
  --arg fa "$fast_alias" --arg fc "$fast_cmd" \
  --arg sa "$smart_alias" --arg sc "$smart_cmd" \
  '.exec_cli_alias[$fa] = $fc
   | .exec_cli_alias[$sa] = $sc
   | .fast_alias  = $fa
   | .smart_alias = $sa' \
  "$cfg" > "$tmp"

mv -f "$tmp" "$cfg"
trap - EXIT
echo "wrote $cfg (fast_alias=$fast_alias, smart_alias=$smart_alias)" >&2
cat "$cfg"
