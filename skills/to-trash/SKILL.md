---
name: to-trash
description: Reversible single-item trash action — move one path to ~/trash/<unix-ts>_<name>/ with a reason sidecar. Use when you want to delete something now and keep a reversal trail. Single-item companion to trash-retired-files (bulk GC). Repo-agnostic; does not touch the ledger.
---

# to-trash

Reverse before destructive. Single-item deletion with a fingerprint so anything moved out can be moved back.

## When to use

- You want to remove a single file or directory and keep a paper trail.
- Reversal matters: a sidecar `reason.md` records why and when.
- You are NOT sweeping a whole repo (that's `trash-retired-files` — bulk, ledger-aware).

## Operation

```bash
to-trash <path> --reason "<one-line why>"   # move + write reason.md sidecar
to-trash <path> --restore                  # reverse (move back from ~/trash/)
```

The handler is the same one `install-to-trash` hooks onto `rm` — same destination, same reversibility — but invoked explicitly with a reason.

## What it does NOT touch

- The ledger. `to-trash` is repo-agnostic; if the deletion has a workflow consequence, write to the ledger separately via `to-ledger`.
- Files inside `.git/`. Stop, talk to a human.
- Anything under `~/vault/` or another already-tracked-gitignored tree.

## Reversal

`~/trash/<unix-ts>_<name>/reason.md` records who, when, why. To restore: `to-trash <trash-dir-name> --restore`. After 30 days un-touched, the directory is swept by `trash-retired-files` — but only if the source skill recognises the item as GC-eligible.
