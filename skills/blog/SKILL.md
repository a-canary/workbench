---
name: blog
description: Pre-PR. Draft a blog entry and write it to the ledger blog table via arc-agents createBlogPost() API, so the post is browsable from the ledger and linked to the originating task. Runs against staged diff or branch-vs-base. Not a post-commit auto-poster.
---

# blog

Before opening a PR, draft an entry that shows what changed, why it matters, and one visual artifact. The entry lands in the ledger `blog` table via the `createBlogPost()` API from arc-agents — not in `index.html`. A reviewer can browse it from the ledger, and the post is linked back to the originating task via `origin_task_id`.

This is a **pre-PR** skill, not a setup or post-commit skill. It runs against staged changes or the branch's diff vs its base — not against `HEAD` after the fact.

## Requirements

- arc-agents installed (provides `createBlogPost()` API)
- Bun runtime (required to execute the TypeScript API)
- Write access to `ARC_LEDGER_DB` (default: `~/vault/ledger.db`)

## When to invoke

- After feature work is done, before `gh pr create`.
- On a WIP branch when you want a visible "what this will demo as" preview.
- Re-run after addressing review feedback if the artifact would change.

## When NOT to invoke

- Doc-only or typo PRs. Skip — feed becomes noise.
- Internal refactor with no observable change. Skip.
- After the PR is merged (too late to review the artifact alongside the code).
- Sensitive changes (credentials, internal infra).

## Invocation

There is no installed `blog` command. The skill is run by executing the
TypeScript API from arc-agents (see **Procedure** step 5 and **Ledger API**
below). From a repo with staged or branch diffs:

```bash
# Pre-PR draft (write a blog row to the ledger):
cd /path/to/your/repo
ARC_AGENTS_ROOT=~/repos/arc-agents \
  bun -e '
    import { Database } from "bun:sqlite";
    import { createBlogPost } from "~/repos/arc-agents/src/ledger/blog.ts";
    import { migrate } from "~/repos/arc-agents/src/ledger/migrate.ts";
    // ...build input from git diff, call createBlogPost(db, input)
  '
```

Flags from earlier revisions (`--base`, `--serve`, `--publish`, `--dry-run`,
`--skip`) are workflow hints — wrap the API call in a script if you want
them. Keep that script under 50 lines; call the API directly rather than
re-introducing a bash shim.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ARC_AGENTS_ROOT` | auto-detect | Path to arc-agents install (worktree or `~/repos/arc-agents`) |
| `ARC_LEDGER_DB` | `~/vault/ledger.db` | Ledger SQLite path |
| `ARC_DEMO_ROOT` | `~/web-demo` | Local asset root (artifact files land here) |
| `ARC_TASK_ID` | unset | Factory worker sets this; becomes `origin_task_id` on the row. Manual invocations leave it NULL. |

## Procedure

```
1. Resolve the diff:
   - if staged changes exist: use `git diff --cached`
   - else: use `git diff <base>...HEAD` (base = --base, else upstream, else main)
   - capture: subject (from last commit or branch name), files changed, stat

2. Pick ONE visual artifact, in priority order:
   a. New/modified image files in the diff (*.png, *.jpg, *.svg, *.webp)
   b. New/modified HTML → screenshot
   c. UI component diff (*.tsx, *.vue, *.svelte) → screenshot the dev server
   d. Diagram source (*.mmd, *.dot, *.puml) → render
   e. CLI tool added/changed → capture `--help` output as text file
   f. Benchmark/eval output in the diff → render as SVG chart
   g. None → ask the user: capture one, or --skip?

3. Copy artifacts into <demo-root>/assets/<branch-or-sha>.<ext>
   Keep < 500KB. Resize if larger. Prefer WebP/compressed JPEG over PNG.

4. Build the entry:
   - title: human headline, plain English — strip `type(scope):` prefixes (humanTitle() render-belt is defense, not the author)
   - project: repo name (from git rev-parse --show-toplevel)
   - body_md: 3-4 sentences prose — what changed + why it matters to a reader. NO `## headers`, NO `diff --git`/diff-stat dumps, NO commit lists, NO `<!-- -->` trailers
   - artifact_path: absolute path to copied artifact (or null)
   - origin_task_id: $ARC_TASK_ID if in factory worker, else null

5. INSERT a blog row via createBlogPost() from arc-agents src/ledger/blog.ts:
   import { Database } from 'bun:sqlite';
   import { createBlogPost } from '$ARC_AGENTS_ROOT/src/ledger/blog.ts';
   import { migrate } from '$ARC_AGENTS_ROOT/src/ledger/migrate.ts';
   // open with PRAGMA foreign_keys = ON, migrate, call createBlogPost(db, input)

   Idempotent: not strictly required (blog id is slug-based; re-running
   on the same diff will produce a different id). But the row is always
   written — re-runs produce new rows, not updates.

   IMPORTANT: failed research, abandoned prototypes, and ruled-out experiments
   STILL get a row. The body carries the 'what we ruled out / why it didn't
   work' write-up. Artifact = whatever partial output exists (or null).
   This is the 'knowledge recorded + reported' requirement.

6. Print the blog id and a ledger query to view it.

7. If --serve: start a local server on first free port from 8087.
   If --publish: rsync <demo-root>/ to $ARC_DEMO_HOST.
```

## origin_task_id wiring

The blog skill is designed to run inside an arc-agents factory worker. When it does, the factory sets `$ARC_TASK_ID` to the task's ledger row id (e.g. `slice-2-blog-skill-writes-blog-rows-inst`). The skill reads this variable and passes it as `origin_task_id` when writing the row.

Manual invocations (running `blog` from a terminal without a factory worker) have no `$ARC_TASK_ID`, so `origin_task_id` is left NULL. Both are valid states.

Detection chain:
1. `$ARC_TASK_ID` (set by arc-agents factory worker)
2. `$ARC_WORKTREE` (if it points to an arc-agents worktree, derive from branch name)
3. NULL (manual post)

## Ledger API

```typescript
import { Database } from "bun:sqlite";
import { createBlogPost } from "{ARC_AGENTS_ROOT}/src/ledger/blog.ts";
import { migrate } from "{ARC_AGENTS_ROOT}/src/ledger/migrate.ts";

const db = new Database(process.env.ARC_LEDGER_DB ?? `${process.env.HOME}/vault/ledger.db`);
db.exec("PRAGMA foreign_keys = ON");
migrate(db);

const post = createBlogPost(db, {
  project: "arc-skills",
  title: "Slice 2: blog skill writes blog rows",
  body_md: "...markdown...",
  artifact_path: "/home/user/web-demo/assets/branch-screenshot.png",
  origin_task_id: "slice-2-blog-skill-writes-blog-rows-inst", // or null
});
// post.id, post.artifact_path, post.origin_task_id returned
```

## Entry shape (what lands in the ledger)

A row in the `blog` table with:
- `id`: slugified title, uniquified on collision
- `project`: repo name
- `title`: human headline (no commit-prefix syntax)
- `body_md`: 3-4 sentence prose per content contract above
- `artifact_path`: absolute path to the visual artifact under `ARC_DEMO_ROOT/assets/` (or null for failed experiments)
- `origin_task_id`: ledger row id of the originating task (from `$ARC_TASK_ID` inside a factory worker; null for manual posts)
- `created_at`: unix timestamp

## Failed experiment handling

Any research path that produced meaningful learnings — even if abandoned or ruled out — gets a blog row. The `body_md` carries the write-up:

```markdown
## What we tried

We explored X because Y. The approach was to ...

## Why it didn't work

Z happened: the [specific failure mode]. This ruled out the following
approaches:
- approach A (conflicts with constraint C)
- approach B (performance unacceptable above N items)

## What we did instead

Settled on alternative: ...
```

`artifact_path` may be null (no visual artifact) or point to whatever partial output exists (e.g. a crashed prototype screenshot, a benchmark CSV that showed the regression).

## Anti-patterns

- Drafting an entry for every PR regardless of value — feed becomes noise. Use `--skip` liberally.
- Auto-publishing without review — the whole point is to review the artifact alongside the code.
- Running this *after* merge — too late to influence the PR.
- Skipping failed experiments — the 'knowledge recorded + reported' rule means even dead ends get a row.
- Lossless PNG screenshots — use WebP/JPEG; feed loads faster.