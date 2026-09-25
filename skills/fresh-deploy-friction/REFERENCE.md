# fresh-deploy-friction — reference

## Why a container, why non-root, why per-user npm prefix

The friction you're hunting is invisible on the author's box because their
environment already absorbed it. Reproduce the *absences*:

- **Non-root `dev` user** — no `sudo`. Forces the no-sudo install path, which is
  what most real users (and CI) actually use.
- **Per-user npm prefix** (`npm config set prefix ~/.npm-global`) — the
  recommended no-sudo global-install location. Its bin dir is NOT a sibling of
  `node`, so naive `dirname $(which node)/../bin` PATH heuristics miss it. This
  single choice surfaces a whole class of "`pi: command not found`" bugs.
- **Login shell on exec** (`bash -lc`) — sources `~/.profile`/`~/.bashrc`, so a
  tool that installs a binary but never exports its dir to a dotfile reproduces
  the failure honestly instead of being masked by your already-fat PATH.
- **Read-only `/src` mounts** — the user-side install must `git clone /src/<r>`
  into the home dir; it physically cannot mutate your working copy.

## Secret injection

Never bake keys into the image. Export them in YOUR shell from the pass store,
then `up` forwards the ones in `FORWARD_ENV`:

```bash
export MINIMAX_API_KEY="$(pass show api/minimax/api-key)"
bash scripts/run.sh up ~/repos/ke
# inside the box the tool reads $MINIMAX_API_KEY like any user would
```

Add provider vars to `FORWARD_ENV` in `run.sh` as needed. Keys live only in the
container's process env, gone on `down`.

## Quoting: prefer cp-exec for anything non-trivial

`exec '<cmd>'` is fine for one-liners. Nested single-quotes inside
`docker exec bash -lc '...'` will bite. For multi-step or quote-heavy steps,
write a host script and use `cp-exec` — it copies the file in, chowns it to
`dev`, and runs it. No quoting gymnastics.

## Worked case study — the a-canary stack (2026-06)

Deploying pi + ke + arc-agents + arc-skills as a fresh user surfaced four real
bugs, each fixed at the source and merged:

1. **`pi: command not found` (exit 127), every headless worker.**
   PATH heuristic only probed node's sibling global bin; the per-user prefix
   (`~/.npm-global/bin`) was never checked. Fix: probe `npm prefix -g`/bin and
   `~/.npm-global/bin` too. *(arc-agents #253)*

2. **`npm install -g ke` installs a stranger's package.** Public-npm `ke` is an
   unrelated stub — a supply-chain footgun a fresh user hits immediately. Fix:
   README -> clone + `npm install` + `npm link` from the real repo, with an
   explicit "public-npm `ke` is not this package" warning. *(ke #41)*

3. **`npm link` CLI silently did nothing.** The entry-module guard compared
   `import.meta.url` to `pathToFileURL(argv[1])` as raw strings; through the
   bin-dir symlink they never match, so `main()` never ran (exit 0, no output).
   Fix: compare `fs.realpathSync(argv[1])` to the module's realpath. *Found only
   at first real use — `--version` would have passed.* *(ke #41)*

4. **Missing-repo fatal stranded the claimed task.** A row whose project repo
   wasn't cloned died deep in `git worktree add`. Fix: fail fast with a message
   naming the missing path AND its `ARC_PROJECT_REPO_<X>` override. *(arc-agents
   #253)*

Plus the cross-platform doc note (run smoke test -> fix -> PR) added to all
three repos' install sections. *(arc-skills #8)*

### Operation-truth check

A ledger/PR can read "merged" while the change landed only on a worker branch.
After merge, confirm the actual code is on `origin/main` by **content**:

```bash
git show origin/main:bin/ke-tool.ts | grep -c isMainModule   # expect >0
```

Not the merge-commit message — the file content.

## Adapting to a different stack

- Swap the documented install command in step 2; everything else holds.
- Add language runtimes the tool needs to the `Dockerfile` apt line (not the
  tool itself — that installs as `dev`, the whole point).
- The smallest-real-task in step 3 should touch the tool's primary verb
  (`ke search`, `arc ledger create`, etc.), not a `--help`/`--version` that
  skips the code paths where install bugs hide.
