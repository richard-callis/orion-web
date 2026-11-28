#!/usr/bin/env bash
# Optional installer step: create the Authentik OAuth2 provider + application + group binding
# for ORION's OIDC login and store issuer/client_id/client_secret in Vault.
# See docs/AUTHENTIK_OIDC.md. Idempotent; safe to re-run.
#
#   ./authentik-oidc-bootstrap.sh https://authentik.example.com [--token-file FILE]
#       [--slug orion] [--group "authentik Admins"] [--vault-path secret/orion/authentik-oidc]
#
# The Authentik API token comes from --token-file (root-owned, not group/world accessible), a
# hidden prompt on a terminal, or stdin (`printf %s "$TOKEN" | ...`). It is never passed in argv or written to a log.
# Exit: 0 = Vault updated (orion needs a restart), 3 = nothing changed, other = failed.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
usage() { echo "Usage: $0 <authentik-base-url> [--token-file FILE] [--slug S] [--group G] [--vault-path P]" >&2; }
URL=""
TOKEN_FILE=""; SLUG="orion"; GROUP="authentik Admins"; VAULT_PATH_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --token-file) TOKEN_FILE="${2:?}"; shift 2 ;;
    --slug) SLUG="${2:?}"; shift 2 ;;
    --group) GROUP="${2:?}"; shift 2 ;;
    --vault-path) VAULT_PATH_ARG="${2:?}"; shift 2 ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) URL="$1"; shift ;;
  esac
done
[[ "$URL" =~ ^https?:// ]] || { usage; exit 2; }

if [[ -n "$TOKEN_FILE" ]]; then
  [[ -f "$TOKEN_FILE" ]] || { echo "Token file not found: $TOKEN_FILE" >&2; exit 2; }
  [[ "$(stat -c %a "$TOKEN_FILE")" =~ ^[0-7]00$ ]] || { echo "Token file must be root-only (chmod 600): $TOKEN_FILE" >&2; exit 2; }
  [[ "$(stat -c %u "$TOKEN_FILE")" == 0 ]] || { echo "Token file must be owned by root: $TOKEN_FILE" >&2; exit 2; }
fi

# shellcheck disable=SC1091
[[ -f "$DEPLOY_DIR/.env" ]] && set -a && source "$DEPLOY_DIR/.env" && set +a
: "${ORION_DOMAIN:?ORION_DOMAIN must be set in deploy/.env}"
# Must match the path orion reads (AUTHENTIK_OIDC_VAULT_PATH, passed through docker-compose.yml).
VAULT_PATH="${VAULT_PATH_ARG:-${AUTHENTIK_OIDC_VAULT_PATH:-secret/orion/authentik-oidc}}"

COMPOSE="docker compose -f $DEPLOY_DIR/docker-compose.yml"
[[ -f "$DEPLOY_DIR/docker-compose.override.yml" ]] && COMPOSE="$COMPOSE -f $DEPLOY_DIR/docker-compose.override.yml"
COMPOSE="$COMPOSE --env-file $DEPLOY_DIR/.env"

# The script runs inside the orion container (it has Vault mTLS + VAULT_TOKEN and Node); its source
# is passed as an argument, the token on stdin.
if [[ -z "$TOKEN_FILE" && -t 0 ]]; then
  read -rsp 'Authentik API token: ' TOK; echo >&2
  exec 3< <(printf %s "$TOK"); unset TOK
else
  exec 3<&0
fi
[[ -n "$TOKEN_FILE" ]] && exec 3<"$TOKEN_FILE"
$COMPOSE exec -T \
  -e ORION_AUTHENTIK_CLI=1 -e "AUTHENTIK_URL=$URL" -e "ORION_HOST=$ORION_DOMAIN" \
  -e "AUTHENTIK_APP_SLUG=$SLUG" -e "AUTHENTIK_ADMIN_GROUP=$GROUP" -e "AUTHENTIK_VAULT_PATH=$VAULT_PATH" \
  orion node --input-type=module -e "$(cat "$DEPLOY_DIR/authentik-oidc.mjs")" <&3
