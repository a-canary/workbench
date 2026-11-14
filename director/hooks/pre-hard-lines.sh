#!/usr/bin/env bash
# PreToolUse hook — hard-lines gate (operator ruling 2026-11-14, repos-peos).
# Blocks live order paths, --admin, force push, repo visibility/access changes.
# Quote-aware shlex; follows wrappers/shell -c/eval/$(...). Exit 2 = blocked.
exec python3 -I "$(dirname "$(readlink -f "$0")")/pre-hard-lines.py"