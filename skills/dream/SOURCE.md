# Source

Migrated from the standalone `dream` plugin (private repo, archived 2026-05-27)
into arc-skills on 2026-05-27.

The plugin was a Claude Code plugin with a bundled `lib/` of Python and a
`${CLAUDE_PLUGIN_ROOT}`-rooted layout. For arc-skills it was reshaped to the
installer-skill pattern: SKILL.md is the skill, support code lives under
`scripts/`, the two custom agents under `agents/`, and `${CLAUDE_PLUGIN_ROOT}`
path refs were rewritten to the skill-relative install path
(`~/.claude/skills/dream/...`). A `SETUP.md` documents the one-time agent
symlink and the fast/smart model split, which the flat arc-skills repo has no
auto-registration for.

The core design — fast model pages bulk logs into a daily journal, smart model
reads it and makes exactly one system edit — is preserved unchanged.

Original prose by a-canary, MIT.
