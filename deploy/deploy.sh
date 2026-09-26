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
  # openssl genrsa defaults to mode 600 (root-owned, since this script runs as root).
  # This key is bind-mounted read-only into the orion container, which runs as the
  # unprivileged "nextjs" user — without this chmod it can never be read, and
  # anything using it (write_secret/generate_secret mTLS to vault-proxy) fails with
  # EACCES. ca.key and tls.key don't need this: ca.key is only read by this script
  # (root), and tls.key is only read by vault-proxy's envoy container (runs as root).
  chmod 644 "$CERTS_DIR/orion-client.key"
  echo "ORION client cert generated."
fi

echo "Taking pre-deploy database backup..."
"$COMPOSE_DIR/backup.sh" --pre-deploy

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

# :3000 is no longer published on localhost (see ORION_BIND_ADDR), so use the
# container's own healthcheck rather than curling the host port.
echo "Waiting for ORION to become healthy..."
"$COMPOSE_DIR/wait-healthy.sh" orion 300
