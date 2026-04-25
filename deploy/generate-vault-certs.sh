#!/usr/bin/env bash
# Generates the CA + server cert for vault-proxy (Envoy TLS) and a per-cluster
# client cert template. Run once after initial deployment.
#
# Usage:
#   ./generate-vault-certs.sh                         # uses MANAGEMENT_IP env or 10.2.2.9
#   MANAGEMENT_IP=10.2.2.9 ./generate-vault-certs.sh
#
# Output:
#   vault-proxy/certs/ca.key      — CA private key      (keep safe, used to sign client certs)
#   vault-proxy/certs/ca.crt      — CA certificate       (distribute to clusters as caBundle)
#   vault-proxy/certs/tls.key     — Envoy private key
#   vault-proxy/certs/tls.crt     — Envoy server cert    (signed by CA)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CERTS_DIR="${SCRIPT_DIR}/vault-proxy/certs"
MANAGEMENT_IP="${MANAGEMENT_IP:-10.2.2.9}"

if [ -f "${CERTS_DIR}/ca.crt" ]; then
  echo "Certs already exist at ${CERTS_DIR}"
  echo "Delete them first to regenerate: rm -rf ${CERTS_DIR}/*.{key,crt,srl}"
  exit 0
fi

mkdir -p "${CERTS_DIR}"

echo "── Generating CA ────────────────────────────────────────────"
openssl genrsa -out "${CERTS_DIR}/ca.key" 4096
openssl req -new -x509 -days 3650 \
  -key "${CERTS_DIR}/ca.key" \
  -out "${CERTS_DIR}/ca.crt" \
  -subj "/CN=ORION Vault Proxy CA/O=ORION"

echo "── Generating server cert (for Envoy) ───────────────────────"
openssl genrsa -out "${CERTS_DIR}/tls.key" 4096

openssl req -new \
  -key "${CERTS_DIR}/tls.key" \
  -out "${CERTS_DIR}/tls.csr" \
  -subj "/CN=vault-proxy/O=ORION"

cat > "${CERTS_DIR}/server-san.cnf" <<EOF
[req_ext]
subjectAltName = @alt_names
[alt_names]
IP.1  = ${MANAGEMENT_IP}
DNS.1 = vault.khalis.corp
DNS.2 = vault
DNS.3 = localhost
EOF

openssl x509 -req -days 3650 \
  -in "${CERTS_DIR}/tls.csr" \
  -CA "${CERTS_DIR}/ca.crt" \
  -CAkey "${CERTS_DIR}/ca.key" \
  -CAcreateserial \
  -out "${CERTS_DIR}/tls.crt" \
  -extfile "${CERTS_DIR}/server-san.cnf" \
  -extensions req_ext

# Cleanup temporaries
rm -f "${CERTS_DIR}/tls.csr" "${CERTS_DIR}/server-san.cnf"

# Lock down private keys
chmod 600 "${CERTS_DIR}/ca.key" "${CERTS_DIR}/tls.key"
chmod 644 "${CERTS_DIR}/ca.crt" "${CERTS_DIR}/tls.crt"

echo ""
echo "Done. Certs written to ${CERTS_DIR}"
echo ""
echo "CA cert (base64) — saved automatically by ORION bootstrap into ClusterSecretStore:"
base64 -w 0 "${CERTS_DIR}/ca.crt"
echo ""
