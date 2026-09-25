# Source

Adapted from a personal `hygiene/gc` skill (archived) on 2026-05-22.

Genericized for public release: removed personal infra paths (`~/agents/`, `~/vault/`, `dev-*` role patterns) and concrete table examples tied to a private system. The core concept — reason-driven semantic GC with reversible trash — is preserved.

Original was internal/unattributed. This rewrite is original prose by a-canary, MIT.

## Changelog

- 2026-06-24: Naming convention changed from `<ts>_<basename>` to `<ts>__<rel-path>` after a basename-collision bug in `000109-hygiene-arc-webui-trash-retired-files` (arc-webui #10) — two `contexts/{encounters,tavern}/CONTEXT.md` files landed in the same trash dir, second move clobbered the first. Restores now require `-- → /` rewrite; restore procedure updated in SKILL.md.
