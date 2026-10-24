#!/usr/bin/env bash
# Re-apply the calculateContextTokens usage guard to the installed pi dist.
# Needed because pi updates (npm) clobber these in-place edits.
# Root cause + upstream patch: pi-ai-estimate-usage-guard.patch (same dir).
set -euo pipefail
D=$(readlink -f "$(command -v pi)" | sed 's|dist/bundle/cli.js||')
[ -d "$D" ] || { echo "pi install dir not found under $D"; exit 1; }
perl -pi -e 's{function calculateContextTokens\(usage\)\{return usage\.totalTokens\|\|usage\.input\+usage\.output\+usage\.cacheRead\+usage\.cacheWrite\}}{function calculateContextTokens(usage){return usage?usage.totalTokens||usage.input+usage.output+usage.cacheRead+usage.cacheWrite:0}}g' \
  "$D"/dist/bundle/chunks/chunk-*.js "$D"/dist/bundle/chunks/bedrock-converse-stream.js \
  "$D"/dist/core/compaction/compaction.js 2>/dev/null || true
perl -pi -e 's{    return usage\.totalTokens \|\| usage\.input \+ usage\.output \+ usage\.cacheRead \+ usage\.cacheWrite;}{    return usage ? usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite : 0;}g' \
  "$D"/dist/core/compaction/compaction.js \
  "$D"/node_modules/@earendil-works/pi-agent-core/dist/harness/compaction/compaction.js \
  "$D"/node_modules/@earendil-works/pi-ai/dist/utils/estimate.js
echo "guarded copies: $(grep -rc "usage?usage.totalTokens\|usage ? usage.totalTokens" "$D"/dist/bundle/chunks/chunk-*.js "$D"/dist/bundle/chunks/bedrock-converse-stream.js "$D"/dist/core/compaction/compaction.js "$D"/node_modules/@earendil-works/pi-agent-core/dist/harness/compaction/compaction.js "$D"/node_modules/@earendil-works/pi-ai/dist/utils/estimate.js 2>/dev/null | grep -v ':0$' | wc -l)/6"
