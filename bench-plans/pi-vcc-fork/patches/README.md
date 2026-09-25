Worker-authored patches, applied by `../patch.sh` in filename order (`01-*.patch`, `02-*.patch`, …).

Ground rules for every patch here:
- Fork is `a-canary/pi-vcc` at upstream master (npm 0.4.1 is older and lacks the
  Strategy A→B→C→D deadlock fix). Rebase on `upstream/master` before patching.
- Upstream `flow/requirements/2026-08-26_vcc-over100-routing.md` R1–R5 binds: R5
  forbids fixing the pi-core geometry trap (single-giant-turn empty summarize
  window, upstream pi#6879) from the extension layer. A kept-tail ceiling is NOT
  that trap — it is inside `buildOwnCut`'s own choice of `firstKeptEntryId`.
- Target: `src/hooks/before-compact.ts` Strategy A (walk-back to last user entry,
  no token ceiling). Add the test to `tests/build-own-cut-strategies.test.ts`.
- Packaging fixes belong in separate patches: `.npmignore` += `demo.gif`,
  `scripts/` (master still ships a 16.4 MB tarball); peer
  `@mariozechner/pi-coding-agent` → `@earendil-works/pi-coding-agent`.
- Each patch must keep `npm test` green; `patch.sh` runs it and the verdict fails on red.
