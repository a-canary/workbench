#!/usr/bin/env bash
# install-skill-agents.sh — symlink a skill's agents/*.md files into
# ~/.claude/agents/ so Claude Code's Task tool can spawn them by name.
#
# Symlinks into the live install (~/ by default — override via
# SKILL_AGENTS_HOME for tests). Idempotent: existing correct symlinks are
# left alone; existing real files or wrong-target links are moved to ~/trash/
# before relinking (same contract as install-behavioral-rules/inject.sh).
#
# Usage:
#   bin/install-skill-agents.sh dream collector.md adapter.md
#   bin/install-skill-agents.sh token-waste waste-analyst.md adapter.md:waste-adapter.md
#   bin/install-skill-agents.sh -a dream   # auto-install all *.md under <skill>/agents/
#   SKILL_AGENTS_HOME=/tmp/fakehome bin/install-skill-agents.sh dream collector.md   # test mode
#
# Each agent arg is either a source filename (installs as same name) or
# "src.md:dst.md" to rename (handles cross-skill name collisions — token-waste
# installs its adapter.md as waste-adapter.md to avoid shadowing dream's).
set -euo pipefail

AUTO=0
if [ "${1:-}" = "-a" ]; then AUTO=1; shift; fi

SKILL="${1:?usage: install-skill-agents.sh [-a] <skill> <agent-name.md>...}"
shift
HOME_BASE="${SKILL_AGENTS_HOME:-$HOME}"
CLAUDE_AGENTS="$HOME_BASE/.claude/agents"
CLAUDE_SKILLS="$HOME_BASE/.claude/skills"
TRASH="${TRASH:-$HOME_BASE/trash}"

SRC_DIR="$CLAUDE_SKILLS/$SKILL/agents"
if [ ! -d "$SRC_DIR" ]; then
  echo "ERROR: no agents/ dir under $CLAUDE_SKILLS/$SKILL" >&2
  exit 1
fi

if [ "$AUTO" -eq 1 ]; then
  shopt -s nullglob
  names=("$SRC_DIR"/*.md)
  shopt -u nullglob
  if [ "${#names[@]}" -eq 0 ]; then
    echo "ERROR: no agent files in $SRC_DIR" >&2
    exit 1
  fi
  names=("${names[@]##*/}")
elif [ "$#" -eq 0 ]; then
  echo "usage: install-skill-agents.sh [-a] <skill> <agent-name.md>..." >&2
  exit 2
else
  names=("$@")
  # Source existence is validated in the loop below (handles "src:dst" rename).
fi

mkdir -p "$CLAUDE_AGENTS" "$TRASH"

ok=0; linked=0; backed_up=0
for spec in "${names[@]}"; do
  src_name="${spec%%:*}"
  dst_name="${spec##*:}"
  # Sanity: "src:dst" requires BOTH sides to be a .md filename (no slashes,
  # no empty). Otherwise we treat the whole spec as a single filename.
  if [ "$src_name" = "$spec" ] || [ "$dst_name" = "$src_name" ] || [[ "$src_name" = */* ]] || [[ "$dst_name" = */* ]]; then
    src_name="$spec"; dst_name="$spec"
  fi
  [ -f "$SRC_DIR/$src_name" ] || { echo "ERROR: $SRC_DIR/$src_name not found" >&2; exit 1; }
  src="$(realpath "$SRC_DIR/$src_name")"
  tgt="$CLAUDE_AGENTS/$dst_name"

  # Already the right symlink? leave it.
  if [ -L "$tgt" ] && [ "$(realpath "$tgt")" = "$src" ]; then
    echo "ok:      $tgt"
    ok=$((ok + 1))
    continue
  fi

  # Wrong link or real file → back up before replacing. PID + nanos disambiguate
  # same-second backups so re-running within the same wallclock second doesn't
  # overwrite the prior trash entry.
  if [ -e "$tgt" ] || [ -L "$tgt" ]; then
    bak="$TRASH/$(date +%s%N)_${dst_name}.${CLAUDE_AGENTS//\//_}.$$.bak"
    mv "$tgt" "$bak"
    backed_up=$((backed_up + 1))
  fi

  ln -s "$src" "$tgt"
  echo "linked:  $tgt -> $src"
  linked=$((linked + 1))
done

echo "summary: ok=$ok linked=$linked backed_up=$backed_up skill=$SKILL"
