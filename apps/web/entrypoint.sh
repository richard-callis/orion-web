#!/bin/sh
set -e

PRISMA="node /app/node_modules/prisma/build/index.js"
export PRISMA_HIDE_UPDATE_MESSAGE=1

# Escape hatch for a migration left in a failed state (P3009). Set e.g.
#   ORION_MIGRATE_RESOLVE_ROLLED_BACK=10_nebula_table,11_seed_storage_stats_tool
# for ONE start, after checking the failed migration is safe to re-run.
# (These two used to be resolved unconditionally on every boot, which could
# hide a real failure. Every deployment has applied them since May 2026, and
# fresh installs never run them — see prisma/MIGRATIONS.md.)
if [ -n "${ORION_MIGRATE_RESOLVE_ROLLED_BACK:-}" ]; then
  for m in $(echo "$ORION_MIGRATE_RESOLVE_ROLLED_BACK" | tr ',' ' '); do
    echo "Marking migration $m as rolled back (ORION_MIGRATE_RESOLVE_ROLLED_BACK)"
    $PRISMA migrate resolve --rolled-back "$m" || true
  done
fi

echo "Running database migrations..."
for i in 1 2 3 4 5 6 7 8; do
  # fresh-install/apply.mjs bootstraps an empty database from the baseline and
  # is a no-op otherwise; both steps are idempotent, so retrying is safe.
  if node prisma/fresh-install/apply.mjs && $PRISMA migrate deploy; then
    break
  fi
  if [ "$i" -eq 8 ]; then
    echo "ERROR: migration failed after 8 attempts"
    exit 1
  fi
  echo "migration attempt $i failed, retrying in 3s..."
  sleep 3
done

# The task orchestrator (worker.js) runs as its own compose service
# (orion-worker) so it receives SIGTERM, drains in-flight tasks, and is
# restarted by Docker if it crashes. Set ORION_EMBEDDED_WORKER=true only for
# single-container setups that don't run that service.
if [ "${ORION_EMBEDDED_WORKER:-false}" = "true" ]; then
  echo "Starting embedded orchestrator (ORION_EMBEDDED_WORKER=true)..."
  node worker.js &
fi

echo "Starting server..."
exec node server.js
