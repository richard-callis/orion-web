#!/usr/bin/env bash
# Optional installer step: create the Authentik OAuth2 provider + application + group binding
# for ORION's OIDC login and store issuer/client_id/client_secret in Vault.
# See docs/AUTHENTIK_OIDC.md. Idempotent; safe to re-run.
#
#   ./authentik-oidc-bootstrap.sh https://authentik.example.com [--token-file FILE]
#       [--slug orion] [--group "authentik Admins"] [--vault-path secret/orion/authentik-oidc]
#
# The Authentik API token comes from --token-file (must not be group/world readable) or
# stdin (`printf %s "$TOKEN" | ...`). It is never passed in argv or written to a log.
# Exit: 0 = Vault updated (orion needs a restart), 3 = nothing changed, other = failed.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="${1:-}"; shift || true
TOKEN_FILE=""; SLUG="orion"; GROUP="authentik Admins"; VAULT_PATH="secret/orion/authentik-oidc"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --token-file) TOKEN_FILE="${2:?}"; shift 2 ;;
    --slug) SLUG="${2:?}"; shift 2 ;;
    --group) GROUP="${2:?}"; shift 2 ;;
    --vault-path) VAULT_PATH="${2:?}"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$URL" ]] || { echo "Usage: $0 <authentik-base-url> [--token-file FILE] [--slug S] [--group G] [--vault-path P]" >&2; exit 2; }

if [[ -n "$TOKEN_FILE" ]]; then
  [[ -f "$TOKEN_FILE" ]] || { echo "Token file not found: $TOKEN_FILE" >&2; exit 2; }
  [[ "$(stat -c %a "$TOKEN_FILE")" =~ ^[0-7]00$ ]] || { echo "Token file must be root-only (chmod 600): $TOKEN_FILE" >&2; exit 2; }
fi

# shellcheck disable=SC1091
[[ -f "$DEPLOY_DIR/.env" ]] && set -a && source "$DEPLOY_DIR/.env" && set +a
: "${ORION_DOMAIN:?ORION_DOMAIN must be set in deploy/.env}"

COMPOSE="docker compose -f $DEPLOY_DIR/docker-compose.yml"
[[ -f "$DEPLOY_DIR/docker-compose.override.yml" ]] && COMPOSE="$COMPOSE -f $DEPLOY_DIR/docker-compose.override.yml"
COMPOSE="$COMPOSE --env-file $DEPLOY_DIR/.env"

# The script runs inside the orion container (it has Vault mTLS + VAULT_TOKEN and Node); its source
# is passed as an argument, the token on stdin.
exec 3<&0
[[ -n "$TOKEN_FILE" ]] && exec 3<"$TOKEN_FILE"
$COMPOSE exec -T \
  -e ORION_AUTHENTIK_CLI=1 -e "AUTHENTIK_URL=$URL" -e "ORION_HOST=$ORION_DOMAIN" \
  -e "AUTHENTIK_APP_SLUG=$SLUG" -e "AUTHENTIK_ADMIN_GROUP=$GROUP" -e "AUTHENTIK_VAULT_PATH=$VAULT_PATH" \
  orion node --input-type=module -e "$(cat "$DEPLOY_DIR/authentik-oidc.mjs")" <&3
