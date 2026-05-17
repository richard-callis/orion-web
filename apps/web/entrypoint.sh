#!/bin/sh
set -e

# Resolve any previously-failed migrations so Prisma doesn't refuse to proceed.
# This handles the case where a migration was partially applied manually before
# the migration file was updated (e.g. IF NOT EXISTS added after the fact).
echo "Checking for failed migrations to resolve..."
node /app/node_modules/prisma/build/index.js migrate resolve --rolled-back 10_nebula_table 2>/dev/null || true

echo "Running database migrations..."
for i in 1 2 3 4 5 6 7 8; do
  if node /app/node_modules/prisma/build/index.js migrate deploy; then
    break
  fi
  if [ "$i" -eq 8 ]; then
    echo "ERROR: migration failed after 8 attempts"
    exit 1
  fi
  echo "migration attempt $i failed, retrying in 3s..."
  sleep 3
done

echo "Starting orchestrator..."
node worker.js &

echo "Starting server..."
exec node server.js
