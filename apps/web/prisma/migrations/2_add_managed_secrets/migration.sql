-- CreateTable
CREATE TABLE "managed_secrets" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "namespace" TEXT NOT NULL DEFAULT 'default',
    "description" TEXT,
    "secretStore" TEXT NOT NULL DEFAULT 'vault-backend',
    "secretStoreKind" TEXT NOT NULL DEFAULT 'ClusterSecretStore',
    "remoteRef" TEXT NOT NULL,
    "targetSecretName" TEXT,
    "refreshInterval" TEXT NOT NULL DEFAULT '1h',
    "dataKeys" JSONB NOT NULL DEFAULT '[]',
    "tags" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "statusMessage" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "managed_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "managed_secrets_environmentId_idx" ON "managed_secrets"("environmentId");

-- AddForeignKey
ALTER TABLE "managed_secrets" ADD CONSTRAINT "managed_secrets_environmentId_fkey"
    FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_secrets" ADD CONSTRAINT "managed_secrets_createdBy_fkey"
    FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
