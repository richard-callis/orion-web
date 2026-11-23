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
# can't be determined. REASON starts with the step that failed (bootstrap, health,
# watch; from the *_OUTCOME variables deploy.yml passes, else "deploy").
set -uo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$DEPLOY_DIR")"
LAST_GOOD="$DEPLOY_DIR/.last-good"
OUT="$DEPLOY_DIR/.last-rollback"

FAILED=deploy
for pair in bootstrap:"${BOOTSTRAP_OUTCOME:-}" health:"${HEALTH_OUTCOME:-}" watch:"${WATCH_OUTCOME:-}"; do
  case "${pair#*:}" in failure|cancelled) FAILED=${pair%%:*}; break ;; esac
done
FAILED="$FAILED failed"

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

if [ ! -f "$LAST_GOOD" ]; then
  finish no_last_good "" "$FAILED; no healthy deploy is recorded (deploy/.last-good)" \
    "Deploy of $FAILED_SHA failed and there is nothing to roll back to (no deploy/.last-good)."
  runbook; exit 1
fi
if [ -z "$GOOD_SHA" ]; then
  finish no_last_good "" "$FAILED; deploy/.last-good has no GIT_SHA" \
    "Deploy of $FAILED_SHA failed and there is nothing to roll back to (deploy/.last-good has no GIT_SHA)."
  runbook; exit 1
fi
if [ "$GOOD_SHA" = "$FAILED_SHA" ]; then
  finish rollback_failed "" "$FAILED; the failed deploy is the recorded last-good ($GOOD_SHA)" \
    "Deploy of $FAILED_SHA failed and it is itself the recorded last-good: not rolling back."
  runbook; exit 1
fi

err=$(mktemp)
if ! changed=$(git -C "$REPO_DIR" diff --name-only "$GOOD_SHA" "$FAILED_SHA" -- apps/web/prisma/migrations 2>"$err"); then
  msg=$(head -c 300 "$err" | tr '\n' ' ')
  rm -f "$err"
  echo "git diff failed: $msg"
  finish skipped_migrations "" "$FAILED; could not compare migrations with $GOOD_SHA: $msg" \
    "Deploy of $FAILED_SHA failed. Not rolling back automatically: could not tell whether it changed migrations since $GOOD_SHA."
  runbook; exit 1
fi
rm -f "$err"
if [ -n "$changed" ]; then
  finish skipped_migrations "" "$FAILED; migrations changed since $GOOD_SHA" \
    "Deploy of $FAILED_SHA failed. Not rolling back automatically: it changed database migrations since $GOOD_SHA, and the old images may not handle the new schema."
  runbook; exit 1
fi

# Compose/bootstrap files back to what the images came from (rollback.sh header), before
# rollback.sh recreates the containers from them: a failed compose/config change must
# not be brought back. If the checkout doesn't apply cleanly, the rollback still goes
# ahead with the files as they are. The next deploy moves forward again from here.
NOTE=""
if ! git -C "$REPO_DIR" checkout --quiet -B main "$GOOD_SHA" 2>&1; then
  echo "::warning::could not check out $GOOD_SHA in $REPO_DIR; its files still match the failed deploy"
  NOTE="; checkout of $GOOD_SHA failed"
fi

if ! "$DEPLOY_DIR/rollback.sh"; then
  echo "rollback.sh already ran; see its output above."
  finish rollback_failed "" "$FAILED; rollback.sh failed (images may be partly pinned to $GOOD_SHA)$NOTE" \
    "Deploy of $FAILED_SHA failed and the rollback to $GOOD_SHA failed. Check the host."
  runbook; exit 1
fi
# rollback.sh waited for orion; it only warns about the worker, which is fatal here.
if ! "$DEPLOY_DIR/wait-healthy.sh" orion-worker 360; then
  echo "rollback.sh already ran; see its output above."
  finish rollback_failed "$GOOD_SHA" "$FAILED; images rolled back to $GOOD_SHA; orion-worker not healthy after it$NOTE" \
    "Deploy of $FAILED_SHA failed; the images are back on $GOOD_SHA but orion-worker is not healthy. Check the host."
  runbook; exit 1
fi

finish rolled_back "$GOOD_SHA" "$FAILED; images rolled back$NOTE" \
  "Deploy of $FAILED_SHA failed and was rolled back to $GOOD_SHA."
exit 1
