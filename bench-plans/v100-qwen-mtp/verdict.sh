#!/usr/bin/env bash
# Mechanical verdict first (jq), then the model writes the narrative and must
# repeat the mechanical decision verbatim; a mismatch fails the step.
set -euo pipefail; . "$(dirname "$0")/env.sh"; D=$(dirname "$0")
jq --argjson c "$CEILING" '
  (.[0].decode_tps) as $b | (max_by(.decode_tps)) as $best |
  {baseline_tps:$b, best:$best.name, best_tps:$best.decode_tps,
   delta_pct:(($best.decode_tps/$b-1)*100|round), ceiling_tps:$c,
   all_same_text:(map(.same_text_as_baseline)|all),
   decision:(if (map(.same_text_as_baseline)|all|not) then "BUG-TEXT-MISMATCH"
             elif $best.decode_tps < 0.6*$c then "FORK-WORTH-EXPLORING" else "NO-FORK" end)}' \
  "$RUN/results.json" >"$RUN/mechanical.json"
cat "$RUN/mechanical.json"
"$D/../../driver/pi.sh" "@$RUN/results.json" "@$RUN/mechanical.json" "$(cat "$D/verdict-prompt.md")" >"$RUN/verdict.md"
grep -q "DECISION: $(jq -r .decision "$RUN/mechanical.json")" "$RUN/verdict.md" || { echo "model verdict does not repeat mechanical decision"; exit 3; }
