#!/usr/bin/env bash
# Wait until a compose service's container reports healthy (its own
# HEALTHCHECK), or fail. Services without a healthcheck count as healthy once
# running.
#
#   wait-healthy.sh <service> [timeout-seconds]     (default 300)
#
# Exits 0 when healthy, 1 on timeout / unhealthy / exited (and prints recent logs).
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE="${1:?usage: wait-healthy.sh <service> [timeout-seconds]}"
TIMEOUT="${2:-300}"
COMPOSE="docker compose -f $DEPLOY_DIR/docker-compose.yml --env-file $DEPLOY_DIR/.env"

deadline=$(( $(date +%s) + TIMEOUT ))
status="unknown"
while (( $(date +%s) < deadline )); do
  cid=$($COMPOSE ps -q "$SERVICE" 2>/dev/null | head -1 || true)
  if [[ -n "$cid" ]]; then
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo unknown)
    case "$status" in
      healthy|running) echo "$SERVICE is $status."; exit 0 ;;
      unhealthy|exited|dead) break ;;
    esac
  fi
  sleep 5
done

echo "ERROR: $SERVICE did not become healthy within ${TIMEOUT}s (last status: $status)" >&2
$COMPOSE logs --tail 50 "$SERVICE" >&2 || true
exit 1
