#!/bin/sh
set -e
echo "Running database migrations..."
for i in 1 2 3 4 5 6 7 8; do
  if node /app/node_modules/prisma/build/index.js db push --skip-generate --accept-data-loss; then
    break
  fi
  if [ "$i" -eq 8 ]; then
    echo "ERROR: db push failed after 8 attempts"
    exit 1
  fi
  echo "db push attempt $i failed, retrying in 8s..."
  sleep 8
done

echo "Starting orchestrator..."
node worker.js &

echo "Starting server..."
exec node server.js
