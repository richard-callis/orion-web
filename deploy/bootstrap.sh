#!/usr/bin/env bash
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Activate the gitea profile if GIT_PROVIDER is gitea-bundled (or unset, for backwards compat)
source "$DEPLOY_DIR/.env" 2>/dev/null || true
GIT_PROVIDER="${GIT_PROVIDER:-gitea-bundled}"
PROFILE_FLAGS=""
if [[ "$GIT_PROVIDER" == "gitea-bundled" ]]; then
  PROFILE_FLAGS="--profile gitea"
fi

COMPOSE="docker compose -f $DEPLOY_DIR/docker-compose.yml --env-file $DEPLOY_DIR/.env $PROFILE_FLAGS"

# ── Argument parsing ──────────────────────────────────────────────────────────
RESET=false
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=true ;;
    --help|-h)
      echo "Usage: bootstrap.sh [--reset]"
      echo ""
      echo "  (no args)   Start the ORION stack, generating tokens if needed"
      echo "  --reset     Stop the stack, wipe all data volumes, then start fresh"
      exit 0
      ;;
  esac
done

echo "ORION — Bootstrap"
echo "==========================="

# ── Reset path ────────────────────────────────────────────────────────────────
if [[ "$RESET" == "true" ]]; then
  echo "⚠  RESET mode: all volumes will be erased."
  read -r -p "Are you sure? Type 'yes' to continue: " confirm
  if [[ "$confirm" != "yes" ]]; then
    echo "Aborted." && exit 1
  fi
  echo "Stopping stack and removing volumes..."
  $COMPOSE down -v --remove-orphans 2>/dev/null || true
  echo "Volumes wiped. Continuing with fresh start..."
  # Clear generated tokens so they are recreated against the fresh data
  sed -i '/^GITEA_ADMIN_TOKEN=/d' "$DEPLOY_DIR/.env"
  echo "GITEA_ADMIN_TOKEN=" >> "$DEPLOY_DIR/.env"
fi

# ── Ensure .env exists ────────────────────────────────────────────────────────
if [[ ! -f "$DEPLOY_DIR/.env" ]]; then
  if [[ ! -f "$DEPLOY_DIR/.env.example" ]]; then
    echo "ERROR: .env.example not found" && exit 1
  fi
  cp "$DEPLOY_DIR/.env.example" "$DEPLOY_DIR/.env"
  echo ""
  echo "Created .env from .env.example."
  echo "Please edit $DEPLOY_DIR/.env and fill in the required values, then re-run."
  exit 0
fi

# ── Auto-generate LOCALHOST_JOIN_TOKEN if missing ─────────────────────────────
if ! grep -q "^LOCALHOST_JOIN_TOKEN=" "$DEPLOY_DIR/.env" || \
   grep -q "^LOCALHOST_JOIN_TOKEN=change-me" "$DEPLOY_DIR/.env" || \
   grep -q "^LOCALHOST_JOIN_TOKEN=$" "$DEPLOY_DIR/.env"; then
  TOKEN=$(openssl rand -hex 32)
  sed -i '/^LOCALHOST_JOIN_TOKEN=/d' "$DEPLOY_DIR/.env"
  echo "LOCALHOST_JOIN_TOKEN=${TOKEN}" >> "$DEPLOY_DIR/.env"
  echo "Generated LOCALHOST_JOIN_TOKEN."
fi

# ── Auto-generate HOST_AGENT_WEBHOOK_SECRET if missing ──────────────────────
if ! grep -q "^HOST_AGENT_WEBHOOK_SECRET=" "$DEPLOY_DIR/.env" || \
   grep -q "^HOST_AGENT_WEBHOOK_SECRET=$" "$DEPLOY_DIR/.env"; then
  TOKEN=$(openssl rand -hex 32)
  sed -i '/^HOST_AGENT_WEBHOOK_SECRET=/d' "$DEPLOY_DIR/.env"
  echo "HOST_AGENT_WEBHOOK_SECRET=${TOKEN}" >> "$DEPLOY_DIR/.env"
  echo "Generated HOST_AGENT_WEBHOOK_SECRET."
  # Write HOST_AGENT_WEBHOOK_SECRET to Vault KV for reference
  if [[ -n "${VAULT_TOKEN:-}" ]]; then
    $COMPOSE exec -T vault vault kv put secret/orion/host-agent \
      webhook_secret="${TOKEN}" >/dev/null 2>&1 || \
      echo "NOTE: Could not write host-agent secret to Vault (Vault may not be unsealed yet)."
  fi
  # Seed SecurityConfig row so the webhook endpoint can look up the secret
  $COMPOSE exec -T orion npx tsx -e "
const { prisma } = require('./src/lib/db');
prisma.securityConfig.upsert({
  where: { key: 'HOST_AGENT_WEBHOOK_SECRET' },
  update: { value: process.env.HOST_AGENT_WEBHOOK_SECRET },
  create: { key: 'HOST_AGENT_WEBHOOK_SECRET', value: process.env.HOST_AGENT_WEBHOOK_SECRET }
}).then(() => process.exit(0)).catch(() => process.exit(1));
" 2>/dev/null || echo "NOTE: Could not seed SecurityConfig (app may not be running yet — run bootstrap.sh again after first start)."
fi

# ── Auto-generate GATEWAY_AUDIT_SECRET if missing ──────────────────────────
if ! grep -q "^GATEWAY_AUDIT_SECRET=" "$DEPLOY_DIR/.env" || \
   grep -q "^GATEWAY_AUDIT_SECRET=$" "$DEPLOY_DIR/.env"; then
  TOKEN=$(openssl rand -hex 32)
  sed -i '/^GATEWAY_AUDIT_SECRET=/d' "$DEPLOY_DIR/.env"
  echo "GATEWAY_AUDIT_SECRET=${TOKEN}" >> "$DEPLOY_DIR/.env"
  echo "Generated GATEWAY_AUDIT_SECRET."
fi

# ── Auto-generate NEXTAUTH_SECRET if placeholder ──────────────────────────────
if grep -q "^NEXTAUTH_SECRET=change-me" "$DEPLOY_DIR/.env"; then
  SECRET=$(openssl rand -base64 32)
  sed -i "s|^NEXTAUTH_SECRET=.*|NEXTAUTH_SECRET=${SECRET}|" "$DEPLOY_DIR/.env"
  echo "Generated NEXTAUTH_SECRET."
fi

# ── Auto-generate bundled Gitea admin credentials ─────────────────────────────
if [[ "${GIT_PROVIDER:-gitea-bundled}" == "gitea-bundled" ]]; then
  if ! grep -q "^GITEA_ADMIN_USER=" "$DEPLOY_DIR/.env" || \
     grep -q "^GITEA_ADMIN_USER=$" "$DEPLOY_DIR/.env"; then
    sed -i '/^GITEA_ADMIN_USER=/d' "$DEPLOY_DIR/.env"
    echo "GITEA_ADMIN_USER=gitea-admin" >> "$DEPLOY_DIR/.env"
    echo "Set GITEA_ADMIN_USER=gitea-admin."
  fi
  if ! grep -q "^GITEA_ADMIN_PASSWORD=" "$DEPLOY_DIR/.env" || \
     grep -q "^GITEA_ADMIN_PASSWORD=$" "$DEPLOY_DIR/.env"; then
    GITEA_PASS=$(openssl rand -hex 16)
    sed -i '/^GITEA_ADMIN_PASSWORD=/d' "$DEPLOY_DIR/.env"
    echo "GITEA_ADMIN_PASSWORD=${GITEA_PASS}" >> "$DEPLOY_DIR/.env"
    echo "Generated GITEA_ADMIN_PASSWORD."
  fi
fi

# ── Fix coredns dir ownership (ORION runs as uid=1001, needs write access) ────
chown -R 1001:1001 "$DEPLOY_DIR/coredns" 2>/dev/null || true

# ── Detect docker.sock GID for vector / orion / gateway docker access ─────────
# The vector container runs as 1000:1000 with group_add to gain access to
# /var/run/docker.sock. The compose default of 999 is a guess — actual GID
# varies per host (e.g. Debian ships 988). Write the real value to .env so
# compose substitutes it correctly on every `up -d`.
if [[ -S /var/run/docker.sock ]]; then
  DETECTED_DOCKER_GID=$(stat -c %g /var/run/docker.sock)
  if ! grep -q "^DOCKER_GID=${DETECTED_DOCKER_GID}$" "$DEPLOY_DIR/.env"; then
    sed -i '/^DOCKER_GID=/d' "$DEPLOY_DIR/.env"
    echo "DOCKER_GID=${DETECTED_DOCKER_GID}" >> "$DEPLOY_DIR/.env"
    echo "Set DOCKER_GID=${DETECTED_DOCKER_GID} (detected from /var/run/docker.sock)."
  fi
fi

# ── Validate required vars ────────────────────────────────────────────────────
source "$DEPLOY_DIR/.env"
MISSING=()
[[ -z "${GITHUB_ORG:-}" ]]        && MISSING+=("GITHUB_ORG")
[[ -z "${POSTGRES_PASSWORD:-}" ]] && MISSING+=("POSTGRES_PASSWORD")

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo ""
  echo "ERROR: The following required variables are not set in .env:"
  for v in "${MISSING[@]}"; do echo "  - $v"; done
  echo "Edit $DEPLOY_DIR/.env and re-run."
  exit 1
fi

# ── Pull latest images ────────────────────────────────────────────────────────
echo ""
echo "Pulling images..."
GITHUB_ORG="${GITHUB_ORG}" $COMPOSE pull

# ── Start stack ───────────────────────────────────────────────────────────────
echo ""
echo "Starting stack..."
GITHUB_ORG="${GITHUB_ORG}" $COMPOSE up -d

# ── Wait for ORION + capture setup token (before any restarts) ────────────────
echo ""
echo "Waiting for ORION to start (up to 30s)..."
for i in $(seq 1 6); do
  SETUP_TOKEN=$(GITHUB_ORG="${GITHUB_ORG}" $COMPOSE logs orion 2>&1 | grep "SETUP_TOKEN" | tail -1 | awk '{print $NF}') || true
  [[ -n "$SETUP_TOKEN" ]] && break
  sleep 5
done

# ── Create Gitea admin user + pre-generate API token (bundled profile only) ───
if [[ "${GIT_PROVIDER:-gitea-bundled}" == "gitea-bundled" ]]; then
  echo ""
  echo "Waiting for Gitea to start (up to 60s)..."
  for i in $(seq 1 12); do
    STATUS=$(GITHUB_ORG="${GITHUB_ORG}" $COMPOSE exec -T gitea curl -sf http://localhost:3000/api/healthz 2>/dev/null && echo "ok" || echo "")
    [[ "$STATUS" == "ok" ]] && break
    sleep 5
  done

  # Create admin user (idempotent — ignore "already exists" error)
  echo "Creating Gitea admin user (${GITEA_ADMIN_USER:-gitea-admin})..."
  GITHUB_ORG="${GITHUB_ORG}" $COMPOSE exec -T --user git gitea \
    gitea admin user create \
      --admin \
      --username "${GITEA_ADMIN_USER:-gitea-admin}" \
      --password "${GITEA_ADMIN_PASSWORD}" \
      --email "admin@local" \
      --must-change-password=false 2>&1 \
    | grep -v "^$" || true

  # Generate an API token via CLI so wizard can skip basic-auth entirely
  if ! grep -q "^GITEA_ADMIN_TOKEN=[^[:space:]]" "$DEPLOY_DIR/.env" 2>/dev/null; then
    echo "Generating Gitea admin API token..."
    # Delete any existing token with same name first (re-run safety)
    GITHUB_ORG="${GITHUB_ORG}" $COMPOSE exec -T --user git gitea \
      gitea admin user delete-token \
        --username "${GITEA_ADMIN_USER:-gitea-admin}" \
        --name "orion-bootstrap" 2>/dev/null || true

    GITEA_TOKEN=$(GITHUB_ORG="${GITHUB_ORG}" $COMPOSE exec -T --user git gitea \
      gitea admin user generate-access-token \
        --username "${GITEA_ADMIN_USER:-gitea-admin}" \
        --token-name "orion-bootstrap" \
        --raw 2>&1 | tail -1 | tr -d '[:space:]')

    if [[ -n "$GITEA_TOKEN" ]]; then
      sed -i '/^GITEA_ADMIN_TOKEN=/d' "$DEPLOY_DIR/.env"
      echo "GITEA_ADMIN_TOKEN=${GITEA_TOKEN}" >> "$DEPLOY_DIR/.env"
      echo "Stored Gitea admin token in .env."
      # Restart ORION to pick up the new token (setup token stays in DB — wizard still works)
      GITHUB_ORG="${GITHUB_ORG}" $COMPOSE up -d --no-deps orion
    else
      echo "WARNING: Failed to generate Gitea admin token — wizard will use basic auth fallback."
    fi
  fi
fi

# ── Enable Vault file audit device (host-agent telemetry) ───────────────────
# This creates the audit log at /vault/audit/audit.log which Vector reads.
# Only runs if Vault is already unsealed and accessible.
echo ""
echo "Enabling Vault file audit device..."
VAULT_ADDR="http://$(hostname -I | awk '{print $1}'):8200"

# Wait for Vault to be ready
for i in $(seq 1 12); do
  VAULT_STATUS=$($COMPOSE exec -T vault vault status -format=json 2>/dev/null | grep -o '"sealed":[[:space:]]*"[^"]*"' || echo "sealed: true")
  if echo "$VAULT_STATUS" | grep -q '"sealed": "false"'; then
    echo "Vault is unsealed."
    break
  fi
  sleep 3
done

# Enable file audit device if not already enabled
AUDIT_ENABLED=$($COMPOSE exec -T vault vault audit list -format=json 2>/dev/null | grep -o '"file/"' || echo "")
if [[ -z "$AUDIT_ENABLED" ]]; then
  VAULT_TOKEN_VAL="${VAULT_TOKEN:-}"
  if [[ -n "$VAULT_TOKEN_VAL" ]]; then
    $COMPOSE exec -T vault vault login "$VAULT_TOKEN_VAL" >/dev/null 2>&1 || true
    $COMPOSE exec -T vault vault audit enable file file_path=/vault/audit/audit.log >/dev/null 2>&1 || {
      echo "NOTE: Could not enable Vault file audit device (may already be enabled or Vault not unsealed)."
    }
  else
    echo "NOTE: VAULT_TOKEN not set — skipping Vault audit device enable."
    echo "  Manual: vault audit enable file file_path=/vault/audit/audit.log"
  fi
else
  echo "Vault file audit device already enabled."
fi

# ── Start Vector shipper ────────────────────────────────────────────────────
echo ""
echo "Starting Vector host telemetry shipper..."
$COMPOSE up -d vector 2>/dev/null || echo "NOTE: Vector service failed to start (check compose logs)."

if [[ -n "${SETUP_TOKEN:-}" ]]; then
  echo ""
  echo "========================================"
  echo "  ORION is ready for first-run setup"
  echo "  Visit: http://$(hostname -I | awk '{print $1}'):3000"
  echo "  Or:    https://${ORION_DOMAIN:-orion.khalis.corp}"
  echo "  Setup token: $SETUP_TOKEN"
  echo "========================================"
else
  echo ""
  echo "Stack started. Visit http://$(hostname -I | awk '{print $1}'):3000 to complete setup."
  echo "(If setup is already done, your ORION is ready to use.)"
fi
