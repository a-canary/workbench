#!/usr/bin/env bash
# PreToolUse hook — host-agent gate (director-oot).
# Blocks direct host-side agent runs (`claude -p`, `claude --print`, `pi -p`)
# outside worker-sandbox. Allows tool-less one-turn `claude -p --allowedTools ""`
# (ask-claude): it can't touch the filesystem, network or secrets.
set -u

input="$(cat)"
tool="$(printf '%s' "$input" | jq -r '.tool_name // empty')"
[ "$tool" != "Bash" ] && exit 0

cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty')"
[ -z "$cmd" ] && exit 0

# Split into segments on shell metacharacters: | ; && || & and newlines.
# && and || each contain & or |, so they yield empty segments (skipped below).
segments="$(printf '%s\n' "$cmd" | sed -E 's/[|;&]/\n/g')"

while IFS= read -r segment; do
  [ -z "$segment" ] && continue

  # Find the command word: skip optional nohup/env/time prefixes and VAR=value
  # assignments. The first remaining token is the command (possibly a path).
  cmd_word=""
  for word in $segment; do
    case "$word" in
      nohup|env|time) continue ;;
      *=*) continue ;;
      *) cmd_word="$word"; break ;;
    esac
  done

  [ -z "$cmd_word" ] && continue

  # Use basename so /home/user/.local/bin/pi is recognized as pi.
  base="${cmd_word##*/}"

  # Match only claude or pi invoked in print mode (-p or --print).
  if [ "$base" = "claude" ] || [ "$base" = "pi" ]; then
    has_print=0
    for word in $segment; do
      if [ "$word" = "-p" ] || [ "$word" = "--print" ]; then
        has_print=1
        break
      fi
    done

    if [ "$has_print" -eq 1 ]; then
      # Allowed: tool-less ask-claude with --allowedTools "" or --allowedTools ''
      if printf '%s' "$segment" | grep -qE -- '--allowedTools[[:space:]]+""' || \
         printf '%s' "$segment" | grep -qE -- "--allowedTools[[:space:]]+''"; then
        continue
      fi

      echo 'HOST_AGENT_BLOCKED: run agents via worker-sandbox (director-oot); tool-less claude -p --allowedTools "" is allowed' >&2
      exit 2
    fi
  fi
done <<< "$segments"

exit 0
