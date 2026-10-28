#!/usr/bin/env bash
# inert-test.sh — repos-0x0: a docs/beads-only component diff must not trigger a full re-bench.
# inert_only <repo> <from> <to>: 0 iff every changed path is inert; non-zero otherwise, incl. git errors.
set -u
here=$(cd "$(dirname "$0")" && pwd)
eval "$(sed -n '/^inert_only() {/,/^}/p' "$here/daily-sweep.sh")"
fails=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1: got $2 want $3"; fails=1; fi; }
r=$(mktemp -d); trap 'rm -rf "$r"' EXIT
g() { git -C "$r" -c user.name=t -c user.email=t@t "$@"; }
g init -q; echo x > "$r/a.ts"; g add a.ts; g commit -qm base; base=$(g rev-parse HEAD)
commit() { mkdir -p "$r/$(dirname "$1")"; echo "$RANDOM" >> "$r/$1"; g add -A; g commit -qm "$1"; g rev-parse HEAD; }
io() { if inert_only "$r" "$1" "$2"; then echo inert; else echo bench; fi; }

c1=$(commit README.md); c2=$(commit docs/guide/x.md); c3=$(commit .beads/issues.jsonl)
c4=$(commit .github/workflows/x.yml); c5=$(commit LICENSE)
check "md/docs/.beads/.github/LICENSE only -> inert" "$(io "$base" "$c5")" inert
c6=$(commit src/b.ts)
check "one code file -> bench"                      "$(io "$base" "$c6")" bench
check "code only in the range end -> bench"          "$(io "$c5" "$c6")" bench
c7=$(commit skills/x/SKILL.md)
check "SKILL.md is behavior (prompt), not docs"      "$(io "$c6" "$c7")" bench
c8=$(commit AGENTS.md)
check "AGENTS.md/CLAUDE.md are behavior (context)"   "$(io "$c7" "$c8")" bench
check "empty range -> bench (nothing proves inert)"  "$(io "$c8" "$c8")" bench
check "unknown ref -> bench (fail safe)"             "$(io "$base" deadbeef)" bench
check "sweep calls inert_only before benching" \
  "$(grep -qE 'inert_only "\$COMPONENT_DIR" "\$LAST_TESTED" "\$LATEST"' "$here/daily-sweep.sh" && echo y || echo n)" y
exit $fails
