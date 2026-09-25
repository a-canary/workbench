---
name: install-behavioral-rules
description: Symlink every harness's user-level config (CLAUDE.md, pi.md, …) to the canonical GLOBAL-RULES.md at the arc-skills repo root. Use when setting up a machine, or when a harness config has drifted from the canonical rules. Idempotent — safe to re-run.
---

# install-behavioral-rules

The always-on behavioral rules (concision, no-reread, recency-gate, subagent-distill, diagnostics-tier, prove-before-scale, TDD baseline) must apply on **every** turn across **every** harness. They can't be situational skills, so each harness's user-level config is a **symlink** to one canonical file.

Situational rules ship as skills instead (`vast-compute`, `ke-memory`) — those load only when relevant. This installer is only for the always-on set.

## Source of truth

`GLOBAL-RULES.md` at the **arc-skills repo root**. Edit it once; every symlinked harness sees the change immediately — no re-sync step. Personal/private overlay lives in `~/vault/USER.md`, which the rules tell every agent to read first.

The canonical file is deliberately named `GLOBAL-RULES.md`, **not** `AGENTS.md`/`CLAUDE.md`: those names are auto-loaded by context-file walk-up, so a global rules file under one of them would be injected twice (user-level config + the `$HOME/AGENTS.md` walk-up hit). The repo's own thin `AGENTS.md` pointer keeps it discoverable for humans and tools that grep the standard name.

## Install / re-link

```
bash skills/install-behavioral-rules/inject.sh
```

The injector symlinks each target to the canonical `GLOBAL-RULES.md`:
- `$HOME/.claude/CLAUDE.md` — Claude Code (user memory)
- `$HOME/.pi/pi.md` — pi legacy path
- `$HOME/.pi/agent/AGENTS.md` — pi global context file
- Any pre-existing real file (or wrong-target symlink) is moved to `~/trash/` first — never clobbered.
- Idempotent: a target already linked correctly is left untouched.

To add a harness, add its **user-level** config path to the `TARGETS` array in `inject.sh`. Never add `$HOME/AGENTS.md`: it sits on every session's walk-up chain and would double-inject the rules (it points at the repo's thin `AGENTS.md` pointer instead).

## Reversal

Replace each symlink with a real file: `rm ~/.claude/CLAUDE.md && cp ~/repos/arc-skills/GLOBAL-RULES.md ~/.claude/CLAUDE.md` (or restore the backup from `~/trash/`).
