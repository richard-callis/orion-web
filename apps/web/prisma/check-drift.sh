#!/usr/bin/env bash
# Replays the full migration path on an EMPTY database and fails if the result
# drifts from schema.prisma. Used by CI (.github/workflows/ci.yml); run locally
# against a throwaway pgvector database:
#
#   docker run -d --rm --name orion-drift -e POSTGRES_PASSWORD=x -p 55432:5432 pgvector/pgvector:pg16
#   DATABASE_URL=postgresql://postgres:x@localhost:55432/postgres apps/web/prisma/check-drift.sh
#
# Never point this at a real database — it applies migrations.
set -euo pipefail
cd "$(dirname "$0")/.."
export PRISMA_HIDE_UPDATE_MESSAGE=1
: "${DATABASE_URL:?DATABASE_URL must point at an empty throwaway database}"

echo "── fresh-install bootstrap"
node prisma/fresh-install/apply.mjs
echo "── migrate deploy"
npx prisma migrate deploy
echo "── migrate deploy (second run must be a no-op)"
npx prisma migrate deploy

echo "── drift check: database vs schema.prisma"
DIFF=$(npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script)

# Objects that exist in the database but cannot be expressed in schema.prisma.
# Each one is created by raw SQL in a migration / baseline.sql. Keep this list short
# and documented — anything else in the diff is real drift.
ALLOWED=(
  'DROP INDEX "InvestigationNote_searchVector_idx";'          # GIN, tsvector
  'DROP INDEX "Note_searchVector_idx";'                       # GIN, tsvector
  'DROP INDEX "nebula_embeddings_embedding_hnsw_idx";'        # pgvector HNSW
  'DROP INDEX "note_embeddings_embedding_hnsw_idx";'          # pgvector HNSW
  'ALTER TABLE "Note" ALTER COLUMN "searchVector" DROP DEFAULT;'  # GENERATED ALWAYS column
  'ALTER TABLE "nebula_embeddings" ALTER COLUMN "embedding" SET DATA TYPE TEXT;'  # vector(768) declared as String
  'ALTER TABLE "note_embeddings" ALTER COLUMN "embedding" SET DATA TYPE TEXT;'    # vector(768) declared as String
  'DROP TABLE "_orion_baseline";'                             # fresh-install marker
)

LEFTOVER=$(printf '%s\n' "$DIFF" | grep -v -e '^--' -e '^[[:space:]]*$' | grep -v -F -x -f <(printf '%s\n' "${ALLOWED[@]}") || true)
if [[ -n "$LEFTOVER" ]]; then
  echo "ERROR: schema.prisma and the migrated database differ. Add a migration (see prisma/MIGRATIONS.md):"
  printf '%s\n' "$LEFTOVER"
  exit 1
fi
echo "OK: migrations replay cleanly and match schema.prisma"
