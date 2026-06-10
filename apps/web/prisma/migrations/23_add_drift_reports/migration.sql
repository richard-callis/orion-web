CREATE TABLE "DriftReport" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'clean',
    "driftCount" INTEGER NOT NULL DEFAULT 0,
    "findings" TEXT NOT NULL DEFAULT '[]',
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DriftReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DriftReport_environmentId_scannedAt_idx" ON "DriftReport"("environmentId", "scannedAt");

ALTER TABLE "DriftReport" ADD CONSTRAINT "DriftReport_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
