#!/bin/sh
# ponytail: weekly merged-branch GC across autonomy repos; branch -d only (never -D), worktree prune first
for r in "$HOME/repos/arc-agents" "$HOME/repos/arc-webui" "$HOME/repos/arc-skills"; do
  git -C "$r" worktree prune
  # merged-branch worktrees block branch -d; remove them first (non-force: skips dirty/locked)
  git -C "$r" worktree list --porcelain | awk '/^worktree /{wt=$2}/^branch /{sub("refs/heads/","",$2);print wt"\t"$2}' \
    | while IFS="$(printf '\t')" read -r wt br; do
        [ "$wt" = "$r" ] && continue
        case "$br" in main|master) continue;; esac
        git -C "$r" branch --merged main 2>/dev/null | grep -qE "^[+ ] $br\$" && git -C "$r" worktree remove "$wt" 2>/dev/null
      done
  git -C "$r" worktree prune
  git -C "$r" branch --merged main 2>/dev/null | grep -vE '^\*|^\+| main$| master$' | xargs -r git -C "$r" branch -d
done
