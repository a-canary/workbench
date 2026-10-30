#!/usr/bin/env bash
# PreToolUse hook — host-agent gate (director-oot opt 3).
# Blocks direct host-side agent runs (`claude -p`, `claude --print`, `pi -p`) outside worker-sandbox,
# including behind wrappers (timeout/sudo/xargs/...), `bash -c`, eval and $(...).
# Allows tool-less one-turn `claude -p --allowedTools ""` (ask-claude): no filesystem, network or secrets.
# Exit 2 = blocked. Logic: pre-host-agent.py (quote-aware shlex; python -I so cwd files cannot shadow stdlib).
exec python3 -I "$(dirname "$(readlink -f "$0")")/pre-host-agent.py"
