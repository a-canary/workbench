#!/usr/bin/env bash
# Self-check for install-skill-agents.sh — exercises: explicit-name, rename
# (src:dst), idempotent rerun, wrong-link repair, real-file backup, auto
# (-a), error paths. Runs entirely under a temp HOME so the live install is
# never touched. Run: bash bin/test_install_skill_agents.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="$REPO_ROOT/bin/install-skill-agents.sh"
[ -x "$HELPER" ] || { echo "FAIL: $HELPER not executable" >&2; exit 1; }

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/skills/dream/agents" "$T/skills/token-waste/agents" "$T/.claude/agents"
printf '# c\n' > "$T/skills/dream/agents/collector.md"
printf '# a\n' > "$T/skills/dream/agents/adapter.md"
printf '# wa\n' > "$T/skills/token-waste/agents/waste-analyst.md"
printf '# wad\n' > "$T/skills/token-waste/agents/adapter.md"
ln -s "$T/skills" "$T/.claude/skills"

export SKILL_AGENTS_HOME="$T" TRASH="$T/trash"
run() { "$HELPER" "$@"; }

assert_file() {
  local link="$1" target="$2"
  [ -L "$link" ] || { echo "FAIL: $link not a symlink" >&2; exit 1; }
  [ "$(realpath "$link")" = "$(realpath "$target")" ] \
    || { echo "FAIL: $link -> $(realpath "$link"), expected $target" >&2; exit 1; }
}

# 1. Explicit names, no rename.
out="$(run dream collector.md adapter.md)"
echo "$out" | grep -q "summary: ok=0 linked=2 backed_up=0 skill=dream" \
  || { echo "FAIL: dream install: $out" >&2; exit 1; }
assert_file "$T/.claude/agents/collector.md" "$T/skills/dream/agents/collector.md"
assert_file "$T/.claude/agents/adapter.md"    "$T/skills/dream/agents/adapter.md"

# 2. Rename via src:dst — token-waste installs adapter.md as waste-adapter.md.
out="$(run token-waste waste-analyst.md adapter.md:waste-adapter.md)"
echo "$out" | grep -q "summary: ok=0 linked=2 backed_up=0 skill=token-waste" \
  || { echo "FAIL: token-waste install: $out" >&2; exit 1; }
assert_file "$T/.claude/agents/waste-analyst.md" "$T/skills/token-waste/agents/waste-analyst.md"
assert_file "$T/.claude/agents/waste-adapter.md" "$T/skills/token-waste/agents/adapter.md"
# dream's adapter.md must be untouched.
assert_file "$T/.claude/agents/adapter.md" "$T/skills/dream/agents/adapter.md"

# 3. Idempotent — all targets already correct.
out="$(run dream collector.md adapter.md)"
echo "$out" | grep -q "summary: ok=2 linked=0 backed_up=0 skill=dream" \
  || { echo "FAIL: idempotent dream: $out" >&2; exit 1; }

# 4. Wrong-target link gets backed up to trash + relinked.
rm "$T/.claude/agents/collector.md"
ln -s /tmp/wrong-target "$T/.claude/agents/collector.md"
out="$(run dream collector.md adapter.md)"
echo "$out" | grep -q "backed_up=1" \
  || { echo "FAIL: wrong-link repair: $out" >&2; exit 1; }
assert_file "$T/.claude/agents/collector.md" "$T/skills/dream/agents/collector.md"
[ "$(ls "$T/trash/" | wc -l)" = "1" ] \
  || { echo "FAIL: expected exactly 1 bak file in trash, got $(ls "$T/trash/")" >&2; exit 1; }

# 5. Real file gets backed up before symlink.
rm "$T/.claude/agents/adapter.md"
echo "stale" > "$T/.claude/agents/adapter.md"
out="$(run dream collector.md adapter.md)"
echo "$out" | grep -q "backed_up=1" \
  || { echo "FAIL: real-file backup: $out" >&2; exit 1; }
assert_file "$T/.claude/agents/adapter.md" "$T/skills/dream/agents/adapter.md"

# 5b. Two same-second backups don't overwrite each other (PID+nanos disambiguator).
rm "$T/.claude/agents/collector.md" "$T/.claude/agents/adapter.md"
echo "x" > "$T/.claude/agents/collector.md"
echo "y" > "$T/.claude/agents/adapter.md"
rm -rf "$T/trash"
mkdir -p "$T/trash"
# Force both mvs into the same wallclock second by running them inside one shell.
( run dream collector.md && run dream adapter.md ) >/dev/null
trash_count=$(ls "$T/trash/" | wc -l)
[ "$trash_count" = "2" ] \
  || { echo "FAIL: expected 2 distinct backups, got $trash_count: $(ls "$T/trash/")" >&2; exit 1; }

# 6. -a auto-discovers all .md files.
rm "$T/.claude/agents/"*.md
out="$(run -a dream)"
echo "$out" | grep -q "summary: ok=0 linked=2 backed_up=0 skill=dream" \
  || { echo "FAIL: -a auto: $out" >&2; exit 1; }

# 7. Error: no args, no -a.
if run dream 2>/dev/null; then
  echo "FAIL: should have errored on no args" >&2; exit 1
fi

# 8. Error: unknown agent name.
if run dream nope.md 2>/dev/null; then
  echo "FAIL: should have errored on unknown agent" >&2; exit 1
fi

# 9. Error: skill with no agents/ dir.
if run does-not-exist foo.md 2>/dev/null; then
  echo "FAIL: should have errored on unknown skill" >&2; exit 1
fi

# 10. Error: rename source doesn't exist.
if run token-waste nope.md:waste-nope.md 2>/dev/null; then
  echo "FAIL: should have errored on unknown rename source" >&2; exit 1
fi

echo "ok"
