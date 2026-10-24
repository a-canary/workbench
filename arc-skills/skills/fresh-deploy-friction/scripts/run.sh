#!/usr/bin/env bash
# fresh-deploy-friction driver. Wraps the disposable fresh-user container so the
# skill body stays declarative. Idempotent where it can be.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="freshdeploy:latest"
NAME="freshdeploy"
# Env vars listed here are forwarded into the container at `up` (values come
# from YOUR shell — export them from the pass store before calling, e.g.
#   export MINIMAX_API_KEY="$(pass show api/minimax/api-key)"
FORWARD_ENV=(MINIMAX_API_KEY OPENROUTER_API_KEY ANTHROPIC_API_KEY QDRANT_URL)

cmd="${1:-}"; shift || true

case "$cmd" in
  build)
    docker build -t "$IMAGE" -f "$HERE/Dockerfile" "$HERE"
    ;;

  up)
    # Remaining args are host repo paths to mount READ-ONLY at /src/<basename>.
    mounts=()
    for repo in "$@"; do
      [ -d "$repo" ] || { echo "skip (not a dir): $repo" >&2; continue; }
      mounts+=( -v "$(cd "$repo" && pwd):/src/$(basename "$repo"):ro" )
    done
    envs=()
    for e in "${FORWARD_ENV[@]}"; do
      [ -n "${!e:-}" ] && envs+=( -e "$e=${!e}" )
    done
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" "${mounts[@]}" "${envs[@]}" "$IMAGE" >/dev/null
    # Read-only /src means `git clone /src/<r> ~/<r>` is the fresh-user move;
    # mark the RO source safe so clone doesn't trip "dubious ownership".
    for repo in "$@"; do
      b="$(basename "$repo")"
      docker exec -u dev "$NAME" git config --global --add safe.directory "/src/$b" || true
    done
    # never echo forwarded secret values — names only
    masked=(); for e in "${envs[@]}"; do masked+=( "${e%%=*}=***" ); done
    echo "up: $NAME  (repos at /src, env: ${masked[*]:-none})"
    ;;

  exec)
    # Run a command as `dev` through a login shell (loads ~/.profile so the
    # PATH-export friction reproduces honestly). Pass ONE quoted arg.
    docker exec -u dev "$NAME" bash -lc "${1:?exec needs a command string}"
    ;;

  cp-exec)
    # For commands too gnarly to quote: write a host script, run it as dev.
    src="${1:?cp-exec needs a host script path}"
    docker cp "$src" "$NAME:/tmp/_step.sh"
    docker exec -u root "$NAME" chown dev:dev /tmp/_step.sh
    docker exec -u dev "$NAME" bash -lc 'chmod +x /tmp/_step.sh && /tmp/_step.sh'
    ;;

  shell)
    docker exec -it -u dev "$NAME" bash -l
    ;;

  down)
    docker rm -f "$NAME" >/dev/null 2>&1 && echo "down: $NAME removed" || echo "down: no container"
    ;;

  clean)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker rmi "$IMAGE" >/dev/null 2>&1 && echo "clean: image removed" || echo "clean: no image"
    ;;

  *)
    echo "usage: run.sh {build|up [repo...]|exec '<cmd>'|cp-exec <script>|shell|down|clean}" >&2
    exit 2
    ;;
esac
