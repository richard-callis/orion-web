#!/usr/bin/env bash
# Watch a fresh deploy and fail if it doesn't stay up.
#
#   watch-deploy.sh [seconds]     (default 600)
#
# Every WATCH_INTERVAL seconds (default 30) each of orion, orion-worker and gateway
# must be running, healthy (Docker health status), still the container seen at the
# start (not recreated) with the same RestartCount, and orion's /api/health must
# answer. /api/health is requested from inside the orion container, as its compose
# healthcheck does. Vector is optional: only a warning. Exits 1 after the first
# check that finds a problem, with an ::error:: line per problem.
set -uo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECONDS_TOTAL="${1:-600}"
INTERVAL="${WATCH_INTERVAL:-30}"
COMPOSE="docker compose -f $DEPLOY_DIR/docker-compose.yml --env-file $DEPLOY_DIR/.env"
REQUIRED=(orion orion-worker gateway)

declare -A CID=() RESTARTS=()

# "<state> <health|none> <restart count>" of a container, or nothing.
inspect() {
  docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}}' "$1" 2>/dev/null
}

container() { $COMPOSE ps -aq "$1" 2>/dev/null | head -1; }

bad=0
problem() { echo "::error::$1 $2"; bad=1; }

check() {  # $1 = baseline pass
  local svc cid state health restarts
  for svc in "${REQUIRED[@]}"; do
    cid=$(container "$svc")
    if [ -z "$cid" ]; then problem "$svc" "has no container"; continue; fi
    if [ "${1:-}" = baseline ]; then CID[$svc]=$cid
    elif [ "$cid" != "${CID[$svc]:-}" ]; then problem "$svc" "was recreated (container ${CID[$svc]:-?} -> $cid)"; continue; fi
    read -r state health restarts < <(inspect "$cid") || true
    if [ -z "${state:-}" ]; then problem "$svc" "could not be inspected"; continue; fi
    if [ "$state" != running ]; then problem "$svc" "is $state, not running"; continue; fi
    case "$health" in healthy|none) ;; *) problem "$svc" "is $health, not healthy" ;; esac
    if [ "${1:-}" = baseline ]; then RESTARTS[$svc]=$restarts
    elif [ "$restarts" != "${RESTARTS[$svc]:-}" ]; then
      problem "$svc" "restarted (RestartCount ${RESTARTS[$svc]:-?} -> $restarts)"
    fi
  done
  if ! docker exec "${CID[orion]:-orion}" curl -fsS --max-time 10 -o /dev/null http://localhost:3000/api/health >/dev/null 2>&1; then
    problem orion "/api/health did not answer OK"
  fi
  cid=$(container vector)
  if [ -z "$cid" ]; then echo "::warning::vector has no container"
  else
    read -r state _ < <(inspect "$cid") || true
    [ "${state:-}" = running ] || echo "::warning::vector is ${state:-not inspectable}"
  fi
  return "$bad"
}

rounds=$(( SECONDS_TOTAL / INTERVAL ))
echo "Watching orion, orion-worker and gateway for ${SECONDS_TOTAL}s (every ${INTERVAL}s)..."
check baseline || { echo "::error::deploy watch failed at the start"; exit 1; }
for ((i = 1; i <= rounds; i++)); do
  sleep "$INTERVAL"
  check || { echo "::error::deploy watch failed after $((i * INTERVAL))s"; exit 1; }
  echo "watch: ok after $((i * INTERVAL))s"
done
echo "Deploy survived the ${SECONDS_TOTAL}s watch."
