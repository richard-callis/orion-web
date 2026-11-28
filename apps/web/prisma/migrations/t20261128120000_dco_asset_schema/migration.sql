-- DCO visibility slice 1a: asset inventory, power windows, container health. Additive only.
-- CreateTable
CREATE TABLE IF NOT EXISTS "Asset" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "environmentId" TEXT,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "primaryMac" TEXT,
    "macRandomised" BOOLEAN NOT NULL DEFAULT false,
    "primaryIp" TEXT,
    "vendor" TEXT,
    "vlan" TEXT,
    "tags" TEXT[],
    "k8sNodeName" TEXT,
    "expectedPower" TEXT NOT NULL DEFAULT 'unknown',
    "known" BOOLEAN NOT NULL DEFAULT false,
    "state" TEXT NOT NULL DEFAULT 'unknown',
    "powerState" TEXT,
    "stateSince" TIMESTAMP(3),
    "muteUntil" TIMESTAMP(3),
    "mergedIntoId" TEXT,
    "probe" JSONB,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3),

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AssetAddress" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "firstSeen" TIMESTAMP(3) NOT NULL,
    "lastSeen" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),

    CONSTRAINT "AssetAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkloadAddress" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "podUid" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "pod" TEXT NOT NULL,
    "ownerKind" TEXT,
    "ownerName" TEXT,
    "nodeAssetId" TEXT,
    "hostNetwork" BOOLEAN NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),

    CONSTRAINT "WorkloadAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AssetStateChange" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "reason" TEXT,

    CONSTRAINT "AssetStateChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PowerWindow" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerRef" TEXT NOT NULL,
    "maxDurationMin" INTEGER NOT NULL,
    "graceMin" INTEGER NOT NULL DEFAULT 30,
    "heartbeatEveryMin" INTEGER NOT NULL DEFAULT 5,
    "linkBackups" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PowerWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PowerWindowRun" (
    "id" TEXT NOT NULL,
    "windowId" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "expectedOffAt" TIMESTAMP(3),
    "lastHeartbeatAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "detail" JSONB,

    CONSTRAINT "PowerWindowRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ExpectedContainer" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "project" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "expectedState" TEXT NOT NULL DEFAULT 'running',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "observedState" TEXT,
    "health" TEXT,
    "restartCount" INTEGER NOT NULL DEFAULT 0,
    "exitCode" INTEGER,
    "lastSeenAt" TIMESTAMP(3),
    "stateSince" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpectedContainer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Asset_key_key" ON "Asset"("key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Asset_primaryIp_idx" ON "Asset"("primaryIp");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Asset_environmentId_idx" ON "Asset"("environmentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AssetAddress_kind_value_validTo_idx" ON "AssetAddress"("kind", "value", "validTo");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AssetAddress_assetId_idx" ON "AssetAddress"("assetId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkloadAddress_ip_validFrom_idx" ON "WorkloadAddress"("ip", "validFrom");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkloadAddress_nodeAssetId_idx" ON "WorkloadAddress"("nodeAssetId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "WorkloadAddress_environmentId_podUid_ip_key" ON "WorkloadAddress"("environmentId", "podUid", "ip");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AssetStateChange_assetId_at_idx" ON "AssetStateChange"("assetId", "at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PowerWindow_assetId_idx" ON "PowerWindow"("assetId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PowerWindowRun_windowId_openedAt_idx" ON "PowerWindowRun"("windowId", "openedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PowerWindowRun_status_idx" ON "PowerWindowRun"("status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ExpectedContainer_assetId_project_service_key" ON "ExpectedContainer"("assetId", "project", "service");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Asset_environmentId_fkey') THEN
    ALTER TABLE "Asset" ADD CONSTRAINT "Asset_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AssetAddress_assetId_fkey') THEN
    ALTER TABLE "AssetAddress" ADD CONSTRAINT "AssetAddress_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WorkloadAddress_environmentId_fkey') THEN
    ALTER TABLE "WorkloadAddress" ADD CONSTRAINT "WorkloadAddress_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WorkloadAddress_nodeAssetId_fkey') THEN
    ALTER TABLE "WorkloadAddress" ADD CONSTRAINT "WorkloadAddress_nodeAssetId_fkey" FOREIGN KEY ("nodeAssetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AssetStateChange_assetId_fkey') THEN
    ALTER TABLE "AssetStateChange" ADD CONSTRAINT "AssetStateChange_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PowerWindow_assetId_fkey') THEN
    ALTER TABLE "PowerWindow" ADD CONSTRAINT "PowerWindow_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PowerWindowRun_windowId_fkey') THEN
    ALTER TABLE "PowerWindowRun" ADD CONSTRAINT "PowerWindowRun_windowId_fkey" FOREIGN KEY ("windowId") REFERENCES "PowerWindow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ExpectedContainer_assetId_fkey') THEN
    ALTER TABLE "ExpectedContainer" ADD CONSTRAINT "ExpectedContainer_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- At most one live owner per address value (partial index: not expressible in schema.prisma).
CREATE UNIQUE INDEX IF NOT EXISTS "AssetAddress_kind_value_live_key" ON "AssetAddress"("kind", "value") WHERE "validTo" IS NULL;
