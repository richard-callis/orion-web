#!/usr/bin/env bash
# Roll ORION's own images back to the last deploy that passed its health check.
#
#   rollback.sh            # images only (safe when the failed deploy ran no migrations)
#   rollback.sh --list     # show the recorded last-good deploy and pre-deploy DB dumps
#
# deploy.yml writes deploy/.last-good after every healthy deploy: the git SHA
# and the registry digest of each ORION image that was running.
#
# Database: migrations run on container start and are NOT reversed by this
# script. If the failed deploy applied a migration the old images can't handle,
# also restore the dump taken just before it, then run this script:
#   docker compose -f docker-compose.yml --env-file .env stop orion orion-worker
#   ./restore.sh --list
#   ./restore.sh predeploy_<timestamp>
#
# After a rollback, `git -C /opt/orion checkout <sha from .last-good>` keeps the
# compose/bootstrap files consistent with the images until the fix lands on main.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAST_GOOD="$DEPLOY_DIR/.last-good"
COMPOSE="docker compose -f $DEPLOY_DIR/docker-compose.yml --env-file $DEPLOY_DIR/.env"

if [[ ! -f "$LAST_GOOD" ]]; then
  echo "ERROR: $LAST_GOOD not found — no healthy deploy has been recorded yet." >&2
  exit 1
fi

if [[ "${1:-}" == "--list" ]]; then
  echo "Last healthy deploy ($LAST_GOOD):"
  sed 's/^/  /' "$LAST_GOOD"
  echo ""
  echo "Pre-deploy database dumps:"
  ls -1t "$DEPLOY_DIR/backups"/postgres_predeploy_*.sql.gz 2>/dev/null | sed 's/^/  /' || echo "  (none)"
  exit 0
fi

# .last-good lines: GIT_SHA=<sha>, and <VAR>=<repo>@sha256:<digest> for
# ORION_WEB_VERSION / ORION_GATEWAY_VERSION / ORION_VECTOR_VERSION.
declare -A REFS=()
while IFS='=' read -r key value; do
  case "$key" in
    ORION_WEB_VERSION|ORION_GATEWAY_VERSION|ORION_VECTOR_VERSION) REFS[$key]="$value" ;;
  esac
done < "$LAST_GOOD"

# Compose references images as <repo>:<tag>, so pull each recorded digest and
# give it a local "rollback" tag, then point the version variables at that tag.
for var in "${!REFS[@]}"; do
  ref="${REFS[$var]}"
  repo="${ref%@*}"
  echo "Pinning $var -> $ref"
  docker pull -q "$ref" >/dev/null
  docker tag "$ref" "$repo:rollback"
  export "$var=rollback"
done

echo "Recreating ORION services on last-good images..."
$COMPOSE up -d --no-build --pull never orion orion-worker gateway vector
"$DEPLOY_DIR/wait-healthy.sh" orion 300
echo "Rollback complete. Last good: $(grep '^GIT_SHA=' "$LAST_GOOD" | cut -d= -f2)"
echo "NOTE: the next bootstrap.sh / CI deploy returns to :latest — merge a fix (or revert) first."
