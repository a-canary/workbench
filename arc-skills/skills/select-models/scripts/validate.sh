#!/usr/bin/env bash
# Validate a candidate agent-cli command template by actually invoking it.
# Usage: validate.sh '<template with {prompt}>'
# The template must contain {prompt} exactly once. We substitute a trivial
# health-check prompt and require non-empty stdout within a timeout.
# Exit 0 = the CLI ran and produced output; non-zero = unusable.

set -uo pipefail

tpl="${1:-}"
[ -n "$tpl" ] || { echo "validate: empty template" >&2; exit 2; }

case "$(grep -o '{prompt}' <<<"$tpl" | wc -l)" in
  1) : ;;
  *) echo "validate: template must contain {prompt} exactly once" >&2; exit 2 ;;
esac

probe='Reply with the single word: ok'
cmd="${tpl/\{prompt\}/$probe}"

out="$(timeout "${VALIDATE_TIMEOUT:-60}" bash -c "$cmd" 2>/tmp/validate.err)"
rc=$?

if [ $rc -ne 0 ]; then
  echo "validate: command exited $rc" >&2
  head -c 500 /tmp/validate.err >&2
  exit 1
fi

if [ -z "${out//[[:space:]]/}" ]; then
  echo "validate: command produced no output" >&2
  exit 1
fi

echo "validate: ok (${#out} chars returned)" >&2
exit 0
