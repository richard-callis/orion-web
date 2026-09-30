#!/usr/bin/env bash
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Image versions exported by the caller (e.g. .github/workflows/deploy.yml pins
# the image it just built) must win over any value in .env, which is sourced
# below. Capture them now and re-export after every `source .env`.
VERSION_OVERRIDES=""
for v in ORION_VERSION ORION_WEB_VERSION ORION_GATEWAY_VERSION ORION_VECTOR_VERSION; do
  if [[ -n "${!v:-}" ]]; then VERSION_OVERRIDES+="export $v=$(printf '%q' "${!v}"); "; fi
done

# Activate the gitea profile if GIT_PROVIDER is gitea-bundled (or unset, for backwards compat)
source "$DEPLOY_DIR/.env" 2>/dev/null || true
eval "$VERSION_OVERRIDES"
GIT_PROVIDER="${GIT_PROVIDER:-gitea-bundled}"
PROFILE_FLAGS=""
if [[ "$GIT_PROVIDER" == "gitea-bundled" ]]; then
  PROFILE_FLAGS="--profile gitea"
fi

# Activate the proxy profile if REVERSE_PROXY_TYPE is docker
REVERSE_PROXY_TYPE="${REVERSE_PROXY_TYPE:-none}"
if [[ "$REVERSE_PROXY_TYPE" == "docker" ]]; then
  PROFILE_FLAGS="$PROFILE_FLAGS --profile proxy"
fi

COMPOSE_FILES="-f $DEPLOY_DIR/docker-compose.yml"
# Site-specific additions (extra_hosts, etc.) live in an untracked override file.
if [[ -f "$DEPLOY_DIR/docker-compose.override.yml" ]]; then
  COMPOSE_FILES="$COMPOSE_FILES -f $DEPLOY_DIR/docker-compose.override.yml"
fi
COMPOSE="docker compose $COMPOSE_FILES --env-file $DEPLOY_DIR/.env $PROFILE_FLAGS"

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

# ── Auto-generate ORION_EXECUTOR_TOKEN if missing ──────────────────────────
# The executor's ONLY credential to ORION (it no longer receives
# ORION_GATEWAY_TOKEN). ORION accepts it solely for execution records and the
# execution-room notice — see apps/web/src/lib/executor-scope.ts.
if ! grep -q "^ORION_EXECUTOR_TOKEN=" "$DEPLOY_DIR/.env" || \
   grep -q "^ORION_EXECUTOR_TOKEN=$" "$DEPLOY_DIR/.env"; then
  TOKEN=$(openssl rand -hex 32)
  sed -i '/^ORION_EXECUTOR_TOKEN=/d' "$DEPLOY_DIR/.env"
  echo "ORION_EXECUTOR_TOKEN=${TOKEN}" >> "$DEPLOY_DIR/.env"
  echo "Generated ORION_EXECUTOR_TOKEN."
fi

# ── Seed NVD_API_KEY into SecurityConfig (Phase 3 PR12) ────────────────────
# CVE enrichment uses the NIST NVD API. Without a key: 5 req/30s; with: 50.
# The env var is optional — if absent, enrichNvd() falls back to anon mode.
# We mirror it to SecurityConfig so the app can read it without restart on
# rotation.
if [[ -n "${NVD_API_KEY:-}" ]]; then
  $COMPOSE exec -T orion npx tsx -e "
const { prisma } = require('./src/lib/db');
prisma.securityConfig.upsert({
  where: { key: 'NVD_API_KEY' },
  update: { value: process.env.NVD_API_KEY },
  create: { key: 'NVD_API_KEY', value: process.env.NVD_API_KEY }
}).then(() => process.exit(0)).catch(() => process.exit(1));
" 2>/dev/null || echo "NOTE: Could not seed NVD_API_KEY in SecurityConfig (app may not be running yet)."
  if [[ -n "${VAULT_TOKEN:-}" ]]; then
    $COMPOSE exec -T vault vault kv put secret/orion/nvd api_key="${NVD_API_KEY}" \
      >/dev/null 2>&1 || echo "NOTE: Could not mirror NVD_API_KEY to Vault."
  fi
fi

# ── Auto-generate FALCO_WEBHOOK_SECRET if missing (Phase 2 PR7) ────────────
# Shared HMAC secret between every Falcosidekick instance (Orion host +
# managed envs) and the /webhooks/falco route. Mirrored to Vault KV so
# managed-env deployments can fetch it via the same vault-proxy that
# already serves managed secrets.
if ! grep -q "^FALCO_WEBHOOK_SECRET=" "$DEPLOY_DIR/.env" || \
   grep -q "^FALCO_WEBHOOK_SECRET=$" "$DEPLOY_DIR/.env"; then
  TOKEN=$(openssl rand -hex 32)
  sed -i '/^FALCO_WEBHOOK_SECRET=/d' "$DEPLOY_DIR/.env"
  echo "FALCO_WEBHOOK_SECRET=${TOKEN}" >> "$DEPLOY_DIR/.env"
  echo "Generated FALCO_WEBHOOK_SECRET."
  if [[ -n "${VAULT_TOKEN:-}" ]]; then
    $COMPOSE exec -T vault vault kv put secret/orion/falco \
      webhook_secret="${TOKEN}" >/dev/null 2>&1 || \
      echo "NOTE: Could not write Falco secret to Vault (Vault may not be unsealed yet)."
  fi
fi

# ── Auto-generate NEXTAUTH_SECRET if placeholder ──────────────────────────────
if grep -q "^NEXTAUTH_SECRET=change-me" "$DEPLOY_DIR/.env"; then
  SECRET=$(openssl rand -base64 32)
  sed -i "s|^NEXTAUTH_SECRET=.*|NEXTAUTH_SECRET=${SECRET}|" "$DEPLOY_DIR/.env"
  echo "Generated NEXTAUTH_SECRET."
fi

# ── Auto-generate MinIO credentials if missing ────────────────────────────────
if ! grep -q "^MINIO_ROOT_USER=" "$DEPLOY_DIR/.env" || grep -q "^MINIO_ROOT_USER=change-me" "$DEPLOY_DIR/.env" || grep -q "^MINIO_ROOT_USER=$" "$DEPLOY_DIR/.env"; then
  sed -i '/^MINIO_ROOT_USER=/d' "$DEPLOY_DIR/.env"
  echo "MINIO_ROOT_USER=orion-minio-$(openssl rand -hex 8)" >> "$DEPLOY_DIR/.env"
  echo "Generated MINIO_ROOT_USER."
fi
if ! grep -q "^MINIO_ROOT_PASSWORD=" "$DEPLOY_DIR/.env" || grep -q "^MINIO_ROOT_PASSWORD=change-me" "$DEPLOY_DIR/.env" || grep -q "^MINIO_ROOT_PASSWORD=$" "$DEPLOY_DIR/.env"; then
  MINIO_PASS=$(openssl rand -hex 24)
  sed -i '/^MINIO_ROOT_PASSWORD=/d' "$DEPLOY_DIR/.env"
  echo "MINIO_ROOT_PASSWORD=${MINIO_PASS}" >> "$DEPLOY_DIR/.env"
  echo "Generated MINIO_ROOT_PASSWORD."
fi

# ── Auto-generate Redis password if missing ───────────────────────────────────
if ! grep -q "^REDIS_PASSWORD=" "$DEPLOY_DIR/.env" || grep -q "^REDIS_PASSWORD=change-me" "$DEPLOY_DIR/.env" || grep -q "^REDIS_PASSWORD=$" "$DEPLOY_DIR/.env"; then
  REDIS_PASS=$(openssl rand -hex 32)
  sed -i '/^REDIS_PASSWORD=/d' "$DEPLOY_DIR/.env"
  echo "REDIS_PASSWORD=${REDIS_PASS}" >> "$DEPLOY_DIR/.env"
  echo "Generated REDIS_PASSWORD."
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

# ── Bind address for ORION's direct :3000 port ────────────────────────────────
# docker-compose.yml publishes :3000 on ORION_BIND_ADDR (default 127.0.0.1)
# instead of every interface. Remote gateways and first-run setup reach ORION
# at http://<management-ip>:3000, so existing installs get the management IP.
if ! grep -q "^ORION_BIND_ADDR=" "$DEPLOY_DIR/.env"; then
  BIND_ADDR="${MANAGEMENT_IP:-}"
  [[ -z "$BIND_ADDR" ]] && BIND_ADDR=$(hostname -I 2>/dev/null | awk '{print $1}')
  BIND_ADDR="${BIND_ADDR:-127.0.0.1}"
  echo "ORION_BIND_ADDR=${BIND_ADDR}" >> "$DEPLOY_DIR/.env"
  echo "Set ORION_BIND_ADDR=${BIND_ADDR} (ORION :3000 is published on this address only)."
fi

# ── Validate required vars ────────────────────────────────────────────────────
source "$DEPLOY_DIR/.env"
eval "$VERSION_OVERRIDES"
MISSING=()
[[ -z "${GITHUB_ORG:-}" ]]        && MISSING+=("GITHUB_ORG")
[[ -z "${POSTGRES_PASSWORD:-}" ]] && MISSING+=("POSTGRES_PASSWORD")
# Deployment-specific network identity — no baked-in defaults.
[[ -z "${MANAGEMENT_IP:-}" ]]       && MISSING+=("MANAGEMENT_IP")
[[ -z "${ORION_DOMAIN:-}" ]]        && MISSING+=("ORION_DOMAIN")
[[ -z "${VAULT_DOMAIN:-}" ]]        && MISSING+=("VAULT_DOMAIN")
[[ -z "${VAULT_ALLOWED_CIDRS:-}" ]] && MISSING+=("VAULT_ALLOWED_CIDRS")
if [[ "$GIT_PROVIDER" == "gitea-bundled" && -z "${GITEA_DOMAIN:-}" ]]; then
  MISSING+=("GITEA_DOMAIN (required when GIT_PROVIDER=gitea-bundled)")
fi

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo ""
  echo "ERROR: The following required variables are not set in .env:"
  for v in "${MISSING[@]}"; do echo "  - $v"; done
  echo "Edit $DEPLOY_DIR/.env and re-run."
  exit 1
fi

# ── Render vault-proxy Envoy config ───────────────────────────────────────────
# envoy.yaml.tmpl → envoy.yaml with one allow-lan principal per CIDR in
# VAULT_ALLOWED_CIDRS (comma-separated, e.g. "192.168.1.0/24,10.0.0.0/16").
ENVOY_PRINCIPALS=""
IFS=',' read -r -a VAULT_CIDRS <<< "$VAULT_ALLOWED_CIDRS"
for cidr in "${VAULT_CIDRS[@]}"; do
  cidr="${cidr// /}"
  [[ -z "$cidr" ]] && continue
  if [[ ! "$cidr" =~ ^([0-9]{1,3}(\.[0-9]{1,3}){3})/([0-9]{1,2})$ ]]; then
    echo "ERROR: VAULT_ALLOWED_CIDRS entry '$cidr' is not an IPv4 CIDR (a.b.c.d/n)." && exit 1
  fi
  ENVOY_PRINCIPALS+="- remote_ip:\n                    address_prefix: ${BASH_REMATCH[1]}\n                    prefix_len: ${BASH_REMATCH[3]}\n                "
done
ENVOY_PRINCIPALS="${ENVOY_PRINCIPALS%\\n                }"
awk -v p="$(printf '%b' "$ENVOY_PRINCIPALS")" '{ sub(/__VAULT_ALLOWED_PRINCIPALS__/, p); print }' \
  "$DEPLOY_DIR/vault-proxy/envoy.yaml.tmpl" > "$DEPLOY_DIR/vault-proxy/envoy.yaml"
echo "Rendered vault-proxy/envoy.yaml (allowing ${VAULT_ALLOWED_CIDRS})."

# ── Seed CoreDNS config ───────────────────────────────────────────────────────
# Corefile is runtime state (the setup wizard adds the internal-domain block);
# only seed it from the template when absent.
if [[ ! -f "$DEPLOY_DIR/coredns/Corefile" ]]; then
  cp "$DEPLOY_DIR/coredns/Corefile.example" "$DEPLOY_DIR/coredns/Corefile"
  chown 1001:1001 "$DEPLOY_DIR/coredns/Corefile" 2>/dev/null || true
  echo "Created coredns/Corefile from Corefile.example."
fi

# ── Pull latest images ────────────────────────────────────────────────────────
echo ""
echo "Pulling images..."
# --ignore-buildable: services with a build: section are handled below, so a
# not-yet-published image (e.g. orion-minio before its first CI build) can't
# fail the whole deploy under set -e.
GITHUB_ORG="${GITHUB_ORG}" $COMPOSE pull --ignore-buildable

# MinIO is built from source (deploy/minio/) and published to GHCR by CI.
# Prefer the registry image; build it here only if it isn't published yet.
if ! GITHUB_ORG="${GITHUB_ORG}" $COMPOSE pull minio minio-init; then
  echo "MinIO images not in the registry yet — building from source (one-off, takes a few minutes)..."
  GITHUB_ORG="${GITHUB_ORG}" $COMPOSE build minio minio-init
fi

# ── Rebuild locally-built services ───────────────────────────────────────────
# These services use build: in docker-compose.yml and are not pushed to a
# registry, so `pull` is a no-op for them. Rebuild on every deploy so that
# source changes (e.g. deploy/orion-claude/server.js) are picked up.
echo ""
echo "Building local services..."
GITHUB_ORG="${GITHUB_ORG}" $COMPOSE build vault-unsealer orion-claude claude-refresh orion-executor

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

# ── Register Gitea Actions Runner (bundled profile only) ─────────────────────
# Registers the host-level act_runner with labels that cover both self-hosted
# and standard ubuntu-latest workflows (e.g. GitOps / Talos cluster pipelines).
# Idempotent: re-runs only when ubuntu-latest label is missing from .runner.
if [[ "${GIT_PROVIDER:-gitea-bundled}" == "gitea-bundled" ]]; then
  source "$DEPLOY_DIR/.env" 2>/dev/null || true
  RUNNER_FILE="/opt/orion-runner/.runner"
  RUNNER_CONFIG="/opt/orion-runner/config.yaml"
  RUNNER_LABELS="self-hosted:docker:ubuntu:latest,docker:docker:ubuntu:latest,localhost:docker:ubuntu:latest,ubuntu-latest:docker:ubuntu:latest"
  RUNNER_NAME="orion-runner-localhost"

  if [[ ! -f "$RUNNER_FILE" ]] || ! grep -q "ubuntu-latest" "$RUNNER_FILE" 2>/dev/null; then
    echo ""
    echo "Registering Gitea Actions Runner ($RUNNER_NAME)..."

    REG_TOKEN=$(curl -sf \
      -X GET "http://localhost:3002/api/v1/admin/runners/registration-token" \
      -H "Authorization: token ${GITEA_ADMIN_TOKEN:-}" \
      2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])" 2>/dev/null || echo "")

    # Gitea v1.26+ removed the registration-token API endpoint; fall back to the
    # static token stored during initial setup.
    if [[ -z "$REG_TOKEN" ]]; then
      REG_TOKEN="${GITEA_RUNNER_TOKEN:-}"
    fi

    if [[ -n "$REG_TOKEN" ]]; then
      (cd /opt/orion-runner && /usr/local/bin/act_runner register \
        --no-interactive \
        --config "$RUNNER_CONFIG" \
        --instance "http://localhost:3002" \
        --token "$REG_TOKEN" \
        --name "$RUNNER_NAME" \
        --labels "$RUNNER_LABELS" 2>&1) | grep -v "^$" || true

      systemctl restart orion-runner 2>/dev/null || true
      echo "Runner registered with labels: $RUNNER_LABELS"
    else
      echo "WARNING: Could not get Gitea runner registration token — skipping runner registration."
      echo "  Re-run bootstrap.sh once Gitea is fully started and GITEA_ADMIN_TOKEN is set."
    fi
  else
    echo "Gitea Actions Runner labels up to date."
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
# Two non-obvious requirements for vector to actually deliver:
#   1. Its data_dir (/var/lib/vector inside the container) must be writable by
#      UID 1000. We bind-mount ./vector-data and chown it here. A named volume
#      would be root-owned and vector would fail with permission denied on
#      checkpoint writes.
#   2. The vector.toml config is mounted as a file. Docker pins file bind-mounts
#      to the host inode at container-create time, so when a deploy rewrites
#      vector.toml via git checkout, the running container keeps reading the
#      OLD content. --force-recreate gives the container a fresh inode binding
#      to the new file. This is why config-only PRs were not landing until
#      someone manually `docker restart`ed vector.
echo ""
echo "Preparing vector data dir..."
mkdir -p "$DEPLOY_DIR/vector-data"
chown -R 1000:1000 "$DEPLOY_DIR/vector-data" 2>/dev/null || true

echo "Starting Vector host telemetry shipper..."
$COMPOSE up -d --force-recreate vector 2>/dev/null || echo "NOTE: Vector service failed to start (check compose logs)."

# Warn about unpinned image tags (SOC2 LOW finding)
if grep -qE ":(latest|[^@\"']+)\"" "$DEPLOY_DIR/docker-compose.yml" 2>/dev/null; then
  echo ""
  echo "NOTE [SOC2-LOW]: Some services use mutable image tags. For production,"
  echo "  pin images to specific digests (e.g. image@sha256:...) in docker-compose.yml."
fi

if [[ -n "${SETUP_TOKEN:-}" ]]; then
  # In CI environments, write the setup token to a file rather than stdout
  # to prevent it appearing in build logs.
  if [[ -n "${CI:-}" ]]; then
    TOKEN_FILE="${RUNNER_TEMP:-/tmp}/orion-setup-token"
    echo "$SETUP_TOKEN" > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
    echo "Setup token written to $TOKEN_FILE (suppressed from CI logs)."
  fi
  echo ""
  echo "========================================"
  echo "  ORION is ready for first-run setup"
  echo "  Visit: http://$(hostname -I | awk '{print $1}'):3000"
  echo "  Or:    https://${ORION_DOMAIN}"
  if [[ -z "${CI:-}" ]]; then echo "  Setup token: $SETUP_TOKEN"; fi
  echo "========================================"
else
  echo ""
  echo "Stack started. Visit http://$(hostname -I | awk '{print $1}'):3000 to complete setup."
  echo "(If setup is already done, your ORION is ready to use.)"
fi

echo ""
echo "IMPORTANT [SOC2]: CI deploys take a pre-deploy database dump (backup.sh --pre-deploy),"
echo "  but no scheduled backup is configured. Schedule one: crontab -e"
echo "  Add: 0 2 * * * $DEPLOY_DIR/backup.sh >> /var/log/orion-backup.log 2>&1"
