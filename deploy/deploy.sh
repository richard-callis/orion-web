#!/usr/bin/env bash
set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$COMPOSE_DIR"

echo "=== ORION Deploy ==="
echo "Pulling latest images from ghcr.io..."

# Pull images (handles image tag rotation from ghcr.io)
docker compose pull --quiet || {
  echo "ERROR: docker compose pull failed"
  exit 1
}

echo "Restarting services..."
docker compose up -d --remove-orphans || {
  echo "ERROR: docker compose up failed"
  exit 1
}

echo "Waiting for ORION to become healthy..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:3000/api/health > /dev/null 2>&1; then
    echo "ORION is healthy!"
    exit 0
  fi
  sleep 2
done

echo "WARNING: ORION health check timed out (may still be starting)"
exit 0
