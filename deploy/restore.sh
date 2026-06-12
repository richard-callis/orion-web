#!/usr/bin/env bash
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DEPLOY_DIR/.env" 2>/dev/null || true
GIT_PROVIDER="${GIT_PROVIDER:-gitea-bundled}"
PROFILE_FLAGS=""
if [[ "$GIT_PROVIDER" == "gitea-bundled" ]]; then
  PROFILE_FLAGS="--profile gitea"
fi
COMPOSE="docker compose -f $DEPLOY_DIR/docker-compose.yml --env-file $DEPLOY_DIR/.env $PROFILE_FLAGS"

BACKUP_DIR="${BACKUP_DIR:-$DEPLOY_DIR/backups}"

usage() {
  echo "Usage: restore.sh <timestamp>"
  echo "       restore.sh --list"
  echo ""
  echo "  <timestamp>   Backup timestamp to restore (e.g. 20250612_020000)"
  echo "  --list        List available backups"
  exit 1
}

if [[ "${1:-}" == "--list" ]]; then
  echo "Available backups in $BACKUP_DIR:"
  ls "$BACKUP_DIR"/postgres_*.sql.gz 2>/dev/null | sed 's/.*postgres_//;s/\.sql\.gz//' || echo "  (none)"
  exit 0
fi

TIMESTAMP="${1:-}"
[[ -z "$TIMESTAMP" ]] && usage

POSTGRES_BACKUP="$BACKUP_DIR/postgres_${TIMESTAMP}.sql.gz"
VAULT_BACKUP="$BACKUP_DIR/vault_${TIMESTAMP}.snap"

if [[ ! -f "$POSTGRES_BACKUP" ]]; then
  echo "ERROR: PostgreSQL backup not found: $POSTGRES_BACKUP" >&2
  exit 1
fi

echo "ORION Restore — $TIMESTAMP"
echo "================================"
echo "WARNING: This will overwrite the current database."
read -r -p "Are you sure? Type 'yes' to continue: " confirm
[[ "$confirm" != "yes" ]] && echo "Aborted." && exit 1

# Restore PostgreSQL
echo "Restoring PostgreSQL..."
$COMPOSE exec -T postgres psql -U "${POSTGRES_USER:-orion}" -c "DROP DATABASE IF EXISTS ${POSTGRES_DB:-orion};" postgres
$COMPOSE exec -T postgres psql -U "${POSTGRES_USER:-orion}" -c "CREATE DATABASE ${POSTGRES_DB:-orion};" postgres
zcat "$POSTGRES_BACKUP" | $COMPOSE exec -T postgres psql -U "${POSTGRES_USER:-orion}" "${POSTGRES_DB:-orion}"
echo "  ✓ PostgreSQL restored"

# Restore Vault snapshot
if [[ -f "$VAULT_BACKUP" ]]; then
  echo "Restoring Vault snapshot..."
  $COMPOSE cp "$VAULT_BACKUP" vault:/tmp/vault-restore.snap
  $COMPOSE exec -T vault vault operator raft snapshot restore -force /tmp/vault-restore.snap 2>/dev/null && \
  echo "  ✓ Vault restored" || \
  echo "  NOTE: Vault restore skipped — restore manually if needed"
else
  echo "  NOTE: No Vault backup found for this timestamp — skipping"
fi

echo ""
echo "Restore complete. Restart ORION: $DEPLOY_DIR/bootstrap.sh"
