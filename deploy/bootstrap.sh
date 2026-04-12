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

# ── Auto-generate NEXTAUTH_SECRET if placeholder ──────────────────────────────
if grep -q "^NEXTAUTH_SECRET=change-me" "$DEPLOY_DIR/.env"; then
  SECRET=$(openssl rand -base64 32)
  sed -i "s|^NEXTAUTH_SECRET=.*|NEXTAUTH_SECRET=${SECRET}|" "$DEPLOY_DIR/.env"
  echo "Generated NEXTAUTH_SECRET."
fi

# ── Fix coredns dir ownership (ORION runs as uid=1001, needs write access) ────
chown -R 1001:1001 "$DEPLOY_DIR/coredns" 2>/dev/null || true

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

# ── Print setup token from ORION logs ─────────────────────────────────────────
echo ""
echo "Waiting for ORION to start (up to 30s)..."
for i in $(seq 1 6); do
  SETUP_TOKEN=$(GITHUB_ORG="${GITHUB_ORG}" $COMPOSE logs orion 2>&1 | grep "SETUP_TOKEN" | tail -1 | awk '{print $NF}')
  [[ -n "$SETUP_TOKEN" ]] && break
  sleep 5
done

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
