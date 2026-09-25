---
name: fresh-deploy-friction
description: Spin up a throwaway fresh-user container, install tools/repos as a brand-new user would (no sudo, no pre-seeded PATH, no cached deps), drive a minimal real task, and turn every snag into a committed fix + PR in the source repo. Use to find install/first-run friction, validate a clean-machine deploy, reproduce a "works on my box" bug, or "simulate a new user installing X".
---

# fresh-deploy-friction

Install instructions rot against the author's machine: their PATH already has the binary, their deps are cached, they run as a user who cloned the repo months ago. A genuinely fresh user hits friction the author can't see. This skill reproduces *that* user in a disposable container, drives a real task end-to-end, and converts each snag into a fix + PR in the source repo.

**Core discipline:** you are role-playing a new user. Take the *minimal* actions a newcomer would — follow the README literally, don't reach for tribal knowledge. A step you "just know" to do is itself a friction finding to document.

## Procedure

### 1. Spin the fresh-user box

Build the throwaway image (non-root `dev` user, per-user npm prefix, no sudo — the install shape that exposes PATH bugs):

```bash
bash scripts/run.sh build      # builds image from scripts/Dockerfile
bash scripts/run.sh up         # starts container `freshdeploy`
```

Source repos mount **read-only** at `/src/<repo>` so the user-side install can't mutate your working copy:

```bash
bash scripts/run.sh up ~/repos/ke ~/repos/arc-agents
```

Secrets (API keys) inject as env vars at `up` time, never baked into the image. See [REFERENCE.md](REFERENCE.md) for pass-store wiring.

### 2. Install as the new user — literally

Run the documented install **verbatim**, as `dev`. Do not fix anything silently. Log each deviation from a clean success:

- command not found after install -> PATH not exported in dotfiles (friction)
- `npm install -g <name>` -> confirm the published package is actually theirs, not a namesake stub (supply-chain friction)
- "dubious ownership" / permission errors -> document the missing `safe.directory` / chown step
- a step you had to *know* to run -> missing from docs (friction)

```bash
bash scripts/run.sh exec 'cd /src/<repo> && <documented install>'
```

### 3. Drive a minimal real task

Pick the smallest task that exercises the tool for real (not `--version`). Run it as `dev`. Install bugs often surface only at first real use (e.g. a symlinked CLI silently no-op'ing). Redirect noisy output to a file and grep it ranged — don't dump logs into context.

### 4. Fix at the source + PR

Fix each friction point in the **source repo** (worktree off `origin/main`, branch `fix/fresh-user-<topic>`), one cohesive change per commit, then PR. Recurring friction -> fix mapping:

| Symptom in the box | Fix in the repo |
|---|---|
| `cmd: command not found` post-install | resolve the install bin dir in runtime PATH logic + dotfile guidance |
| wrong/namesake npm package | README: clone + `npm link` from the real repo + explicit "not the npm package" warning |
| CLI runs nothing via symlink | resolve entry by realpath, not raw `argv[1]` string compare |
| missing-prereq fatal | fail fast with a message naming the missing path AND its override |

Add a **cross-platform note** to install docs directing the next agent (Windows/macOS especially) to run the smoke test first, fix the cause, and PR doc/script fixes. Verify the fix *in the box* (rebuild or re-exec), merge once terminal/CI evidence is green, prune the worktree.

### 5. Tear down

```bash
bash scripts/run.sh down        # stop + rm container
bash scripts/run.sh clean       # also rm image
```

## Notes

- One change per PR (PR-per-feature). Split commits when a repo's slice-guard caps top-level areas.
- Verify the fix lands on `origin/main` by content, not just the merge-commit message — merged-row != on-main.
- Env/secret wiring, Dockerfile rationale, full case study: [REFERENCE.md](REFERENCE.md).
