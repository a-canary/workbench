#!/usr/bin/env bash
# arc-skills doc-drift guard.
#
# Fails the gate on known falsified-claim patterns in skill markdown. Each
# rule is a grep that has caught real drift that slipped past the
# dream / token-waste / recency-gate self-heal loops. The test is
# intentionally small and explicit — add a rule when a new drift shape
# appears, with a one-line comment naming the commit that introduced it.
#
# Run locally before opening a PR:
#   bin/arc-skills-doc-drift.sh
# Exit 0 = clean, 1 = at least one drift pattern matched.

set -uo pipefail
cd "$(dirname "$0")/.."

fail=0

# Rule 1 — 'model: minimax' in skill markdown where matching agents/*.md says haiku.
# Pattern source: commit 7588f08 (collector.md minimax→haiku). The code was
# fixed; the SKILL.md / SETUP.md wiring-claim half slipped through.
for md in skills/*/SKILL.md skills/*/SETUP.md; do
  [[ -f "$md" ]] || continue
  skill_dir=$(dirname "$md")
  [[ -d "$skill_dir/agents" ]] || continue
  if grep -qF 'model: minimax' "$md" \
     && grep -rq '^model: haiku' "$skill_dir/agents/"; then
    echo "FAIL: $md claims 'model: minimax' but $skill_dir/agents/*.md says 'model: haiku'" >&2
    fail=1
  fi
done

# Rule 2 — 'claude --bg' in any SKILL.md / SETUP.md. The live install is
# 'claude -p' (see bin/nightly-self-improve.sh, which drives it via `pi -p`). SKILL.md
# claiming --bg is a falsified invocation shape — there is no such flag in
# current `claude`; the real flag is `-p` / `--print` for headless mode.
if matches=$(grep -rln 'claude --bg' skills/*/SKILL.md skills/*/SETUP.md 2>/dev/null) && [[ -n "$matches" ]]; then
  echo "FAIL: SKILL.md / SETUP.md contains 'claude --bg' but live install uses 'claude -p':" >&2
  echo "$matches" >&2
  fail=1
fi

# Rule 3 — 'home-lab-1' in any SKILL.md / SETUP.md. Violates README curation
# principle #3 (no personal infra paths or private system refs in skill bodies).
if matches=$(grep -rln 'home-lab-1' skills/*/SKILL.md skills/*/SETUP.md 2>/dev/null) && [[ -n "$matches" ]]; then
  echo "FAIL: SKILL.md / SETUP.md contains 'home-lab-1' (private infra; README curation #3):" >&2
  echo "$matches" >&2
  fail=1
fi

# Rule 4 — embedded git worktree under .claude/worktrees/. The .gitignore rule
# (added c36503a) keeps new ones untracked but does not catch one already on
# disk. Pattern source: worker/000102-hygiene-arc-skills-improve-architecture
# — axi-coding-standard worktree survived squash-merge of #16, was 1.2M / 139
# files of pure dirt. A clean `git status` should never list anything under
# .claude/worktrees/.
if [[ -d .claude/worktrees ]] && compgen -G '.claude/worktrees/*/.git' >/dev/null; then
  echo "FAIL: embedded git worktree(s) under .claude/worktrees/ — worker worktrees belong at ~/worktrees/<repo>-<slug>/:" >&2
  compgen -G '.claude/worktrees/*/.git' | sed 's|^|  |' >&2
  fail=1
fi

if [[ $fail -eq 0 ]]; then
  echo "ok: no doc-drift patterns found in skills/*/SKILL.md / SETUP.md"
fi

exit $fail
