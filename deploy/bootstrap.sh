#!/usr/bin/env bash
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "ORION — Bootstrap"
echo "==========================="

# Ensure .env exists
if [[ ! -f "$DEPLOY_DIR/.env" ]]; then
  if [[ ! -f "$DEPLOY_DIR/.env.example" ]]; then
    echo "ERROR: .env.example not found" && exit 1
  fi
  cp "$DEPLOY_DIR/.env.example" "$DEPLOY_DIR/.env"
  echo ""
  echo "Created .env from .env.example."
  echo "Please edit $DEPLOY_DIR/.env and set RPI_IP and POSTGRES_PASSWORD, then re-run."
  exit 0
fi

# Substitute RPI_IP into CoreDNS zone file
source "$DEPLOY_DIR/.env"
sed -i "s/\${RPI_IP}/$RPI_IP/g" "$DEPLOY_DIR/coredns/zones/khalis.corp.db"

# Pull latest images
echo ""
echo "Pulling images..."
docker compose -f "$DEPLOY_DIR/docker-compose.yml" --env-file "$DEPLOY_DIR/.env" pull

# Start stack
echo ""
echo "Starting stack..."
docker compose -f "$DEPLOY_DIR/docker-compose.yml" --env-file "$DEPLOY_DIR/.env" up -d

# Print first-run token from ORION logs
echo ""
echo "Waiting for ORION to start..."
sleep 5
SETUP_TOKEN=$(docker compose -f "$DEPLOY_DIR/docker-compose.yml" logs orion 2>&1 | grep "SETUP_TOKEN" | tail -1 | awk '{print $NF}')

if [[ -n "$SETUP_TOKEN" ]]; then
  echo ""
  echo "========================================"
  echo "  ORION is ready for first-run setup"
  echo "  Visit: https://${ORION_DOMAIN:-orion.khalis.corp}"
  echo "  Setup token: $SETUP_TOKEN"
  echo "========================================"
else
  echo ""
  echo "Stack started. Visit https://${ORION_DOMAIN:-orion.khalis.corp} to complete setup."
fi
