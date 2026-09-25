---
name: install-to-trash
description: Install a PreToolUse hook that intercepts `rm` calls and routes them through reversible trash-move instead.
---

# install-to-trash

The `trash-retired-files` skill makes deletions reversible *when invoked*. This installer makes them reversible *by default*, by replacing direct `rm` with a trash-move at the harness layer.

## What gets installed

One PreToolUse hook that fires on every Bash tool call. It scans the command for unguarded `rm` and either rewrites it to `to-trash`, blocks it with an explanation, or lets it through with a warning depending on policy.

## Hook script

### `~/.claude/hooks/intercept-rm.sh`

```bash
#!/usr/bin/env bash
# PreToolUse hook for Bash. Reads JSON payload from stdin.
# Policy: rewrite `rm <path>` to `to-trash <path> --reason "<inferred>"`,
#         block `rm -rf` of paths outside CWD,
#         allow `rm` inside ephemeral dirs (/tmp, node_modules, .git internal).

set -euo pipefail

payload=$(cat)
cmd=$(echo "$payload" | jq -r '.tool_input.command // ""')

# Empty / non-rm: allow
if ! echo "$cmd" | grep -qE '(^|;|&&|\|\| )\s*rm\b'; then
  exit 0
fi

# Ephemeral dirs: allow
if echo "$cmd" | grep -qE 'rm[^;]*(/tmp/|node_modules|\.git/(objects|refs)|\.cache/)'; then
  exit 0
fi

# rm -rf outside CWD: block
if echo "$cmd" | grep -qE 'rm\s+-[a-z]*r[a-z]*f' && \
   echo "$cmd" | grep -qE 'rm[^;]*\s+/(?!tmp|var/tmp)'; then
  echo '{"decision":"block","reason":"rm -rf on absolute path outside /tmp. Use to-trash or invoke with explicit user confirmation."}'
  exit 0
fi

# Default: nag with a rewrite suggestion (non-blocking)
suggested=$(echo "$cmd" | sed -E 's#\brm\s+([^&;|]+)#to-trash \1 --reason "from-claude"#')
echo "{\"decision\":\"allow\",\"systemMessage\":\"[install-to-trash] Consider: $suggested\"}"
exit 0
```

## settings.json patch

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "~/.claude/hooks/intercept-rm.sh" }
        ]
      }
    ]
  }
}
```

## CLI

```bash
install-to-trash                     # dry-run preview
install-to-trash --apply             # write hook + merge settings
install-to-trash --apply --strict    # blocking mode: rm gets blocked, not nagged
install-to-trash uninstall
```

## Modes

| Mode | Behavior |
|---|---|
| **nag** (default) | Allows `rm`, prints suggested `to-trash` rewrite as a system message |
| **strict** | Blocks `rm` outside ephemeral dirs entirely; requires `to-trash` or explicit user override |
| **off-paths** | Strict mode only for paths matching a configured allowlist (e.g., only protect `~/repos/`) |

## Install procedure

```
1. Verify `to-trash` is on PATH (install if missing — see trash-retired-files skill)
2. Write intercept-rm.sh; chmod +x
3. Back up settings.json → settings.json.bak.<ts>
4. Merge PreToolUse entry (dedupe by command path)
5. Print: "Installed in <mode> mode. Test with `rm /tmp/test-file`."
```

## What this does NOT do

- Does not intercept `unlink`, `find -delete`, `shred`, or other deletion paths. Defense in depth would add them; the 80/20 is `rm`.
- Does not protect against direct filesystem syscalls from compiled binaries.
- Does not survive `sudo` — the hook only fires on the harness's Bash tool.
- Does not block `git clean -fd` or `git checkout -- .` — those are git's deletions, not the user's.
