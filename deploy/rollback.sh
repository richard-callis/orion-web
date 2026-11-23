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
# The worker's health is only a warning here: images from before its heartbeat
# (worker/heartbeat.ts) never turn healthy.
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
PINS=$(mktemp)
trap 'rm -f "$PINS"' EXIT
while IFS='=' read -r key value; do
  case "$key" in
    ORION_WEB_VERSION|ORION_GATEWAY_VERSION|ORION_VECTOR_VERSION) REFS[$key]="$value" ;;
  esac
done < "$LAST_GOOD"

# Compose references images as <repo>:<tag>. A deploy records each image's registry
# tag (TAG_<VAR>) beside its digest: pin that tag, after checking it still names the
# recorded image, also in .env so a compose command or bootstrap.sh run by hand keeps
# the rollback and can pull it. Without one (an older .last-good), the digest gets a
# local "rollback" tag, used for this run only: it can't be pulled.
declare -A TAGS=()
while IFS='=' read -r key value; do
  case "$key" in TAG_ORION_WEB_VERSION|TAG_ORION_GATEWAY_VERSION|TAG_ORION_VECTOR_VERSION) TAGS[${key#TAG_}]="$value" ;; esac
done < "$LAST_GOOD"
for var in "${!REFS[@]}"; do
  ref="${REFS[$var]}"
  repo="${ref%@*}"
  echo "Pinning $var -> $ref"
  docker pull -q "$ref" >/dev/null
  tag="${TAGS[$var]:-}"
  if [ -n "$tag" ] && docker pull -q "$repo:$tag" >/dev/null 2>&1 \
     && [ "$(docker image inspect --format '{{.Id}}' "$repo:$tag")" = "$(docker image inspect --format '{{.Id}}' "$ref")" ]; then
    export "$var=$tag"
    echo "$var=$tag" >> "$PINS"
  else
    echo "  (no registry tag for it: local tag 'rollback', not written to .env)"
    old=$(sed -n "s/^$var=//p" "$DEPLOY_DIR/.env" | tail -1)
    [ -z "$old" ] || echo "WARNING: .env still pins $var=$old: a compose command or bootstrap.sh run by hand brings that image back." >&2
    docker tag "$ref" "$repo:rollback"
    export "$var=rollback"
  fi
done
[ ! -s "$PINS" ] || "$DEPLOY_DIR/set-image-pins.sh" < "$PINS"

echo "Recreating ORION services on last-good images..."
$COMPOSE up -d --no-build --pull never orion orion-worker gateway
# --no-deps: vector depends on docker-read-proxy, which is built here and not rolled back.
$COMPOSE up -d --no-build --pull never --no-deps vector
"$DEPLOY_DIR/wait-healthy.sh" orion 300
echo "Images are rolled back. Checking orion-worker (up to 6 minutes; a failure here is only a warning)..."
# Not fatal: an image from before the worker heartbeat runs fine but never turns healthy.
"$DEPLOY_DIR/wait-healthy.sh" orion-worker 360 || \
  echo "WARNING: orion-worker is not healthy. Expected for an image from before its heartbeat; otherwise check 'docker inspect' RestartCount and its logs." >&2
echo "Rollback complete. Last good: $(grep '^GIT_SHA=' "$LAST_GOOD" | cut -d= -f2)"
echo "NOTE: .env pins the rolled-back images where their registry tags are known, but the next CI deploy returns to the images of main's history (deploy/resolve_images.py): merge a fix (or revert) first."
