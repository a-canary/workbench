#!/usr/bin/env bash
# Decode throughput per server config, same prompt, greedy. Speculative decoding
# is exact, so every config's text must equal baseline's: that equality is the
# quality gate. Rows land in $RUN/results.json.
set -euo pipefail; . "$(dirname "$0")/env.sh"; D=$(dirname "$0")
msgs=$(jq -Rs '{messages:[{role:"user",content:.}]}' "$D/prompt.txt")
echo '[]' >"$RUN/results.json"; base=""
while IFS='|' read -r name args; do
  [ -n "$name" ] || continue
  # shellcheck disable=SC2086
  "$SERVER" -m "$MODEL" -ngl 99 $DEVICE_ARG --host 127.0.0.1 --port "$PORT" -c "$CTX" --parallel 1 $args >"$RUN/server-$name.log" 2>&1 &
  pid=$!
  for _ in $(seq 150); do
    curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
    kill -0 "$pid" 2>/dev/null || { echo "server died during load: $name"; exit 2; }
    sleep 2
  done
  # instruct model on a raw prompt emits EOS at once: apply the chat template server-side
  prompt=$(curl -sf "http://127.0.0.1:$PORT/apply-template" -H 'content-type: application/json' -d "$msgs" | jq .prompt)
  [ -n "$prompt" ] && [ "$prompt" != null ] || { echo "apply-template failed: $name"; kill "$pid"; exit 2; }
  # warm-up (weights paged in), then the measured request
  curl -sf "http://127.0.0.1:$PORT/completion" -H 'content-type: application/json' \
    -d "{\"prompt\":$prompt,\"n_predict\":32,\"temperature\":0,\"cache_prompt\":false}" >/dev/null
  curl -sf "http://127.0.0.1:$PORT/completion" -H 'content-type: application/json' \
    -d "{\"prompt\":$prompt,\"n_predict\":$N_PREDICT,\"temperature\":0,\"seed\":1,\"cache_prompt\":false}" >"$RUN/resp-$name.json"
  kill "$pid"; wait "$pid" 2>/dev/null || true
  # a near-empty generation is an infra fault, never a throughput row
  [ "$(jq .tokens_predicted "$RUN/resp-$name.json")" -ge 8 ] || { echo "generation stopped early (stop_type=$(jq -r .stop_type "$RUN/resp-$name.json")): $name"; exit 2; }
  txt=$(jq -r .content "$RUN/resp-$name.json"); [ -n "$base" ] || base=$txt
  same=$([ "$txt" = "$base" ] && echo true || echo false)
  jq --arg n "$name" --arg a "$args" --argjson same "$same" \
    '{name:$n,args:$a,prompt_tps:.timings.prompt_per_second,decode_tps:.timings.predicted_per_second,tokens:.tokens_predicted,draft_n:(.timings.draft_n//null),draft_accepted:(.timings.draft_n_accepted//null),same_text_as_baseline:$same}' \
    "$RUN/resp-$name.json" >"$RUN/row.tmp"
  jq -s '.[0] + [.[1]]' "$RUN/results.json" "$RUN/row.tmp" >"$RUN/r.tmp" && mv "$RUN/r.tmp" "$RUN/results.json"
  jq -c '.[-1]' "$RUN/results.json"
done <"$D/configs"
