---
name: resolving-merge-conflicts
description: "Use when you need to resolve an in-progress git merge/rebase conflict."
---

1. **See the current state** of the merge/rebase. Check git history, and the conflicting files.

2. **Find the primary sources** for each conflict. Understand deeply why each change was made, and what the original intent was. Read the commit messages, check the PRs, check original issues/tickets.

3. **Resolve each hunk.** Preserve both intents where possible. Where incompatible, pick the one matching the merge's stated goal and note the trade-off. Do **not** invent new behaviour. Always resolve; never `--abort`.

4. Discover the project's **automated checks** and run them — typically typecheck, then tests, then format. Fix anything the merge broke.

5. **Finish the merge/rebase.** Stage everything and commit. If rebasing, continue the rebase process until all commits are rebased.

## Concept-decompose mode (for diverged branches)

When two branches have **drifted** across many files (typical: long-lived
feature branch + main, or two competing rewrites), don't try to resolve
line-by-line. Convert it to a concept-by-concept problem first:

1. Generate a **file-diff outline** between the two branches:
   `git diff --stat <a>...<b>` then `git diff <a>...<b> -- <file>` per file.
2. Group changes by **concept** (a feature, a surface, a contract — not a
   file). A concept may span several files.
3. Resolve **one concept at a time** as a micro-merge: pick a side, port
   the other side's intent, commit, then move to the next concept.
4. Run automated checks between concepts, not just at the end — each
   concept-commit should leave the tree in a coherent state.
5. Surface the concept list to the operator and ask which concepts they
   approve for steal/adapt before merging each individually (`ponytail:`
   if the operator prefers, this becomes the per-step approval gate).
