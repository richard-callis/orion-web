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
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# ── --pre-deploy: fast PostgreSQL-only dump taken before every deploy ────────
# Migrations run automatically when the new orion container starts and cannot
# be rolled back, so this dump is the rollback path for the database:
#   deploy/restore.sh predeploy_<timestamp>   (see deploy/rollback.sh)
# Keeps the newest PREDEPLOY_KEEP dumps. Fails the deploy
# if the dump fails; skips (exit 0) when no database is running yet.
if [[ "${1:-}" == "--pre-deploy" ]]; then
  if [[ -z "$($COMPOSE ps -q --status running postgres 2>/dev/null)" ]]; then
    echo "Pre-deploy backup: postgres is not running (fresh install?) — skipping."
    exit 0
  fi
  OUT="$BACKUP_DIR/postgres_predeploy_${TIMESTAMP}.sql.gz"
  echo "Pre-deploy backup: dumping PostgreSQL to $OUT"
  $COMPOSE exec -T postgres pg_dump -U "${POSTGRES_USER:-orion}" "${POSTGRES_DB:-orion}" \
    | gzip > "$OUT.partial"
  gzip -t "$OUT.partial"
  mv "$OUT.partial" "$OUT"
  chmod 600 "$OUT"
  ls -1t "$BACKUP_DIR"/postgres_predeploy_*.sql.gz 2>/dev/null | tail -n +$(( ${PREDEPLOY_KEEP:-10} + 1 )) | xargs -r rm -f
  echo "  ✓ $(du -h "$OUT" | cut -f1) — keeping newest ${PREDEPLOY_KEEP:-10} pre-deploy dumps"
  exit 0
fi

echo "ORION Backup — $TIMESTAMP"
echo "================================"

# 1. PostgreSQL
echo "Backing up PostgreSQL..."
$COMPOSE exec -T postgres pg_dump \
  -U "${POSTGRES_USER:-orion}" \
  "${POSTGRES_DB:-orion}" \
  | gzip > "$BACKUP_DIR/postgres_${TIMESTAMP}.sql.gz"
chmod 600 "$BACKUP_DIR/postgres_${TIMESTAMP}.sql.gz"
echo "  ✓ PostgreSQL: $BACKUP_DIR/postgres_${TIMESTAMP}.sql.gz"

# 2. Vault raft snapshot (if unsealed)
echo "Backing up Vault..."
if [[ -n "${VAULT_TOKEN:-}" ]]; then
  $COMPOSE exec -T vault sh -c "vault operator raft snapshot save /tmp/vault-snap.snap" 2>/dev/null && \
  $COMPOSE cp vault:/tmp/vault-snap.snap "$BACKUP_DIR/vault_${TIMESTAMP}.snap" 2>/dev/null && \
  echo "  ✓ Vault: $BACKUP_DIR/vault_${TIMESTAMP}.snap" || \
  echo "  NOTE: Vault snapshot skipped (not unsealed or not using raft storage)"
else
  echo "  NOTE: Vault backup skipped — VAULT_TOKEN not set"
fi

# 3. MinIO (requires mc client)
echo "Backing up MinIO..."
if command -v mc &>/dev/null; then
  mc alias set orion-bkp "http://localhost:${MINIO_PORT:-9000}" \
    "${MINIO_ROOT_USER:-}" "${MINIO_ROOT_PASSWORD:-}" --insecure 2>/dev/null && \
  mc mirror --overwrite orion-bkp/ "$BACKUP_DIR/minio_${TIMESTAMP}/" 2>/dev/null && \
  echo "  ✓ MinIO: $BACKUP_DIR/minio_${TIMESTAMP}/" || \
  echo "  NOTE: MinIO mirror failed — check mc configuration"
else
  echo "  NOTE: MinIO backup skipped — install mc: https://min.io/docs/minio/linux/reference/minio-mc.html"
fi

# 4. Prune backups older than 30 days
find "$BACKUP_DIR" -name "postgres_*.sql.gz" -mtime +30 -delete 2>/dev/null || true
find "$BACKUP_DIR" -name "vault_*.snap" -mtime +30 -delete 2>/dev/null || true

echo ""
echo "Backup complete — files in: $BACKUP_DIR"
echo "RPO target: run daily via cron:"
echo "  0 2 * * * $DEPLOY_DIR/backup.sh >> /var/log/orion-backup.log 2>&1"
