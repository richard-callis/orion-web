-- CreateTable
CREATE TABLE "Nebula" (
  "id"          TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "description" TEXT,
  "gitUrl"      TEXT NOT NULL,
  "branch"      TEXT NOT NULL DEFAULT 'main',
  "path"        TEXT NOT NULL DEFAULT 'novas',
  "isSystem"    BOOLEAN NOT NULL DEFAULT false,
  "lastSyncAt"  TIMESTAMP(3),
  "syncStatus"  TEXT NOT NULL DEFAULT 'pending',
  "syncError"   TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Nebula_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Nebula_name_key" ON "Nebula"("name");
