#!/usr/bin/env bash
# Run by deploy.yml's "Automatic rollback" step after a failed deploy whose new version
# was started. Rolls the images back to deploy/.last-good (rollback.sh), unless that
# is unsafe or impossible, and records what happened in deploy/.last-rollback
# (FAILED_SHA, ROLLED_BACK_TO, RESULT, AT, REASON). Always exits non-zero: a deploy
# that had to be rolled back is not a success.
#
# RESULT: rolled_back | skipped_migrations | no_last_good | rollback_failed
#
# Not rolled back when the failed commit changed apps/web/prisma/migrations since the
# last-good one: its migrations may already have run and the old images may not handle
# that schema (restoring the pre-deploy dump is a manual decision), or when that
# can't be determined.
set -uo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$DEPLOY_DIR")"
LAST_GOOD="$DEPLOY_DIR/.last-good"
OUT="$DEPLOY_DIR/.last-rollback"

FAILED_SHA=$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || true)
GOOD_SHA=""
[ ! -f "$LAST_GOOD" ] || GOOD_SHA=$(sed -n 's/^GIT_SHA=//p' "$LAST_GOOD" | tail -1)

finish() {  # <result> <rolled back to> <reason> <::error:: message>
  local tmp
  tmp=$(mktemp "$DEPLOY_DIR/.last-rollback.XXXXXX")
  {
    echo "FAILED_SHA=$FAILED_SHA"
    echo "ROLLED_BACK_TO=$2"
    echo "RESULT=$1"
    echo "AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "REASON=$(printf '%s' "$3" | tr '\n' ' ')"
  } > "$tmp"
  chmod 0644 "$tmp"
  mv "$tmp" "$OUT"
  echo "::error::$4"
}

runbook() {
  echo "Last healthy deploy:"; cat "$LAST_GOOD" 2>/dev/null || echo "  (none recorded)"
  echo ""
  echo "To roll back on the host (see deploy/rollback.sh header):"
  echo "  1. Images only:  $DEPLOY_DIR/rollback.sh"
  echo "  2. If a migration ran and the old code can't handle it, first restore the DB:"
  echo "       docker compose -f $DEPLOY_DIR/docker-compose.yml --env-file $DEPLOY_DIR/.env stop orion orion-worker"
  echo "       $DEPLOY_DIR/restore.sh predeploy_<timestamp>   # newest: $(ls -1t "$DEPLOY_DIR"/backups/postgres_predeploy_*.sql.gz 2>/dev/null | head -1)"
  echo "     then run rollback.sh."
}

if [ ! -f "$LAST_GOOD" ] || [ -z "$GOOD_SHA" ]; then
  finish no_last_good "" "no healthy deploy is recorded (deploy/.last-good)" \
    "Deploy of $FAILED_SHA failed and there is nothing to roll back to (no deploy/.last-good)."
  exit 1
fi

if ! changed=$(git -C "$REPO_DIR" diff --name-only "$GOOD_SHA" "$FAILED_SHA" -- apps/web/prisma/migrations 2>&1); then
  finish skipped_migrations "" "could not compare migrations with $GOOD_SHA: $changed" \
    "Deploy of $FAILED_SHA failed. Not rolling back automatically: could not tell whether it changed migrations since $GOOD_SHA."
  runbook; exit 1
fi
if [ -n "$changed" ]; then
  finish skipped_migrations "" "migrations changed since $GOOD_SHA" \
    "Deploy of $FAILED_SHA failed. Not rolling back automatically: it changed database migrations since $GOOD_SHA, and the old images may not handle the new schema."
  runbook; exit 1
fi

if ! "$DEPLOY_DIR/rollback.sh" \
   || ! "$DEPLOY_DIR/wait-healthy.sh" orion 300 \
   || ! "$DEPLOY_DIR/wait-healthy.sh" orion-worker 360; then
  finish rollback_failed "" "rollback.sh failed or orion/orion-worker are not healthy after it" \
    "Deploy of $FAILED_SHA failed and the rollback to $GOOD_SHA did not leave ORION healthy. Check the host."
  runbook; exit 1
fi

# Compose/bootstrap files back to what the images came from (rollback.sh header). Best
# effort: a checkout that doesn't apply cleanly is left alone. The next deploy moves
# forward again from here.
if ! git -C "$REPO_DIR" checkout --quiet -B main "$GOOD_SHA" 2>&1; then
  echo "::warning::could not check out $GOOD_SHA in $REPO_DIR; its files still match the failed deploy"
fi
finish rolled_back "$GOOD_SHA" "deploy failed; images rolled back" \
  "Deploy of $FAILED_SHA failed and was rolled back to $GOOD_SHA."
exit 1
