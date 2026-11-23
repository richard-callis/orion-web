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
# check that finds a problem, with an ::error:: line per problem. A recreated container,
# a changed RestartCount or a container that isn't running fail at once; an unhealthy
# status or a failed /api/health only after WATCH_TOLERANCE (default 2) checks in a row.
set -uo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECONDS_TOTAL="${1:-600}"
INTERVAL="${WATCH_INTERVAL:-30}"
COMPOSE="docker compose -f $DEPLOY_DIR/docker-compose.yml --env-file $DEPLOY_DIR/.env"
REQUIRED=(orion orion-worker gateway)

declare -A CID=() RESTARTS=() MISSES=()
VECTOR_STATE=""
TOLERANCE="${WATCH_TOLERANCE:-2}"

# "<state> <health|none> <restart count>" of a container, or nothing.
inspect() {
  docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}}' "$1" 2>/dev/null
}

container() { $COMPOSE ps -aq "$1" 2>/dev/null | head -1; }

bad=0
orion_bad=0
problem() { echo "::error::$1 $2"; bad=1; [ "$1" != orion ] || orion_bad=1; }

# A bad health sample (status, /api/health) fails the watch only after TOLERANCE rounds
# in a row: the worker heartbeat can go stale during long inference. $1 = counter key.
soft() {  # <key> <service> <what>
  MISSES[$1]=$(( ${MISSES[$1]:-0} + 1 ))
  if (( MISSES[$1] >= TOLERANCE )); then problem "$2" "$3 (${MISSES[$1]} checks in a row)"
  else echo "::warning::$2 $3 (check ${MISSES[$1]} of $TOLERANCE; fails if it persists)"; fi
}

check() {  # $1 = baseline pass
  local svc cid state health restarts out rc vstate
  orion_bad=0
  for svc in "${REQUIRED[@]}"; do
    if ! cid=$(container "$svc"); then problem "$svc" "could not be listed (docker compose ps failed)"; continue; fi
    if [ -z "$cid" ]; then problem "$svc" "has no container"; continue; fi
    if [ "${1:-}" = baseline ]; then CID[$svc]=$cid
    elif [ "$cid" != "${CID[$svc]:-}" ]; then problem "$svc" "was recreated (container ${CID[$svc]:-?} -> $cid)"; continue; fi
    read -r state health restarts < <(inspect "$cid") || true
    if [ -z "${state:-}" ]; then problem "$svc" "could not be inspected"; continue; fi
    if [ "$state" != running ]; then problem "$svc" "is $state, not running"; continue; fi
    case "$health" in
      healthy|none) MISSES[$svc]=0 ;;
      *) soft "$svc" "$svc" "is $health, not healthy" ;;
    esac
    if [ "${1:-}" = baseline ]; then RESTARTS[$svc]=$restarts
    elif [ "$restarts" != "${RESTARTS[$svc]:-}" ]; then
      problem "$svc" "restarted (RestartCount ${RESTARTS[$svc]:-?} -> $restarts)"
    fi
  done
  if [ "$orion_bad" = 0 ]; then
    out=$(docker exec "${CID[orion]:-orion}" curl -fsS --max-time 10 -o /dev/null http://localhost:3000/api/health 2>&1); rc=$?
    if [ "$rc" = 0 ]; then MISSES[orion-api]=0
    else soft orion-api orion "/api/health did not answer OK (exit $rc: ${out:0:200})"; fi
  fi
  vstate=""
  if ! cid=$(container vector); then vstate="could not be listed"
  elif [ -z "$cid" ]; then vstate="has no container"
  else
    read -r state _ < <(inspect "$cid") || true
    [ "${state:-}" = running ] || vstate="is ${state:-not inspectable}"
  fi
  if [ -n "$vstate" ] && [ "$vstate" != "$VECTOR_STATE" ]; then echo "::warning::vector $vstate"; fi
  VECTOR_STATE=$vstate
  return "$bad"
}

[[ $SECONDS_TOTAL =~ ^(0|[1-9][0-9]*)$ && $INTERVAL =~ ^[1-9][0-9]*$ && $TOLERANCE =~ ^[1-9][0-9]*$ ]] || {
  echo "::error::usage: watch-deploy.sh [seconds] (WATCH_INTERVAL and WATCH_TOLERANCE > 0)"; exit 2; }
rounds=$(( SECONDS_TOTAL / INTERVAL ))
(( rounds >= 1 )) || rounds=1
echo "Watching orion, orion-worker and gateway for ${SECONDS_TOTAL}s (every ${INTERVAL}s)..."
check baseline || { echo "::error::deploy watch failed at the start"; exit 1; }
for ((i = 1; i <= rounds; i++)); do
  sleep "$INTERVAL"
  check || { echo "::error::deploy watch failed after $((i * INTERVAL))s"; exit 1; }
  echo "watch: ok after $((i * INTERVAL))s"
done
echo "Deploy survived the ${SECONDS_TOTAL}s watch."
