#!/usr/bin/env bash
# Mechanical verdict first, then the model narrates and must repeat it verbatim.
set -euo pipefail; . "$(dirname "$0")/env.sh"; D=$(dirname "$0")
for f in baseline measure; do [ -s "$RUN/$f.txt" ] || { echo "VERDICT: INFRA_FAULT ($f.txt missing)"; exit 1; }; done
grep -q "^IMPORT_ERROR" "$RUN/measure.txt" "$RUN/baseline.txt" && { echo "VERDICT: INFRA_FAULT (import failed — deps, not a result)"; exit 1; }
maxb=$(awk -F'\t' 'NR>1&&$3+0>x{x=$3+0}END{print x+0}' "$RUN/baseline.txt")
maxm=$(awk -F'\t' 'NR>1&&$3+0>x{x=$3+0}END{print x+0}' "$RUN/measure.txt")
over=$(awk -F'\t' -v B="$TAIL_TOKEN_BUDGET" 'NR>1&&$3+0>B{printf "%s=%s ",$1,$3}' "$RUN/measure.txt")
db=$(awk -F'\t' 'NR>1&&$2~/^defer/{n++}END{print n+0}' "$RUN/baseline.txt")
dm=$(awk -F'\t' 'NR>1&&$2~/^defer/{n++}END{print n+0}' "$RUN/measure.txt")
crash=$(awk -F'\t' 'NR>1&&$2=="crash"{n++}END{print n+0}' "$RUN/measure.txt")
pt=$(grep -o "tests=[a-z]*" "$RUN/patch.txt" 2>/dev/null || echo tests=absent)
v=PASS; r=""
[ -n "$over" ] && { v=FAIL; r="tail over budget($TAIL_TOKEN_BUDGET): $over"; }
[ "$dm" -gt "$db" ] && { v=FAIL; r="$r new defers $db->$dm"; }
[ "$crash" -gt 0 ] && { v=FAIL; r="$r crashes=$crash"; }
[ "$pt" = tests=fail ] && { v=FAIL; r="$r fork test suite red"; }
grep -q "^NO_PATCH" "$RUN/patch.txt" 2>/dev/null && [ "$maxm" -gt "$TAIL_TOKEN_BUDGET" ] && { v=FAIL; r="NO_PATCH and tail unbounded (max=${maxm}tok)"; }
{ echo "VERDICT: $v"; echo "max_tail_tok baseline=$maxb patched=$maxm budget=$TAIL_TOKEN_BUDGET defers=$db->$dm crashes=$crash $pt"; echo "detail: ${r:-none}"; } | tee "$RUN/mechanical.txt"
"$D/../../driver/pi.sh" "@$RUN/mechanical.txt" "@$RUN/baseline.txt" "@$RUN/measure.txt" "@$RUN/patch.txt" "$(cat "$D/verdict-prompt.md")" >"$RUN/verdict.md"
grep -q "VERDICT: $v" "$RUN/verdict.md" || { echo "model verdict does not repeat mechanical decision"; exit 3; }
[ "$v" = PASS ]
