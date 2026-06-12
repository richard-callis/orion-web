#!/usr/bin/env bash
set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$COMPOSE_DIR"

echo "=== ORION Deploy ==="

# ── Generate ORION mTLS client cert for vault-proxy if not present ────────────
CERTS_DIR="$COMPOSE_DIR/vault-proxy/certs"
if [ -f "$CERTS_DIR/ca.crt" ] && [ -f "$CERTS_DIR/ca.key" ] && [ ! -f "$CERTS_DIR/orion-client.crt" ]; then
  echo "Generating ORION mTLS client cert for vault-proxy..."
  openssl genrsa -out "$CERTS_DIR/orion-client.key" 4096 2>/dev/null
  openssl req -new -key "$CERTS_DIR/orion-client.key" \
    -out "$CERTS_DIR/orion-client.csr" \
    -subj "/CN=orion-client/O=ORION" 2>/dev/null
  openssl x509 -req \
    -in "$CERTS_DIR/orion-client.csr" \
    -CA "$CERTS_DIR/ca.crt" -CAkey "$CERTS_DIR/ca.key" -CAserial "$CERTS_DIR/ca.srl" \
    -out "$CERTS_DIR/orion-client.crt" -days 3650 -sha256 2>/dev/null
  rm -f "$CERTS_DIR/orion-client.csr"
  echo "ORION client cert generated."
fi

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
  if curl -sf --max-time 10 http://localhost:3000/api/health > /dev/null 2>&1; then
    echo "ORION is healthy!"
    exit 0
  fi
  sleep 2
done

if ! curl -sf --max-time 10 http://localhost:3000/api/health 2>/dev/null; then
  echo "ERROR: ORION health check failed" >&2
  exit 1
fi
