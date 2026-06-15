CREATE TABLE "VulnerabilityScan" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "driver" TEXT NOT NULL DEFAULT 'trivy',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "triggeredBy" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "findingsCreated" INTEGER NOT NULL DEFAULT 0,
    "findingsEscalated" INTEGER NOT NULL DEFAULT 0,
    "findingsFixed" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "VulnerabilityScan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VulnerabilityScan_environmentId_startedAt_idx" ON "VulnerabilityScan"("environmentId", "startedAt");
CREATE INDEX "VulnerabilityScan_status_idx" ON "VulnerabilityScan"("status");

ALTER TABLE "VulnerabilityScan" ADD CONSTRAINT "VulnerabilityScan_environmentId_fkey"
    FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "VulnerabilityFinding"
    ADD COLUMN "title" TEXT,
    ADD COLUMN "description" TEXT,
    ADD COLUMN "fixAvailable" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "taskId" TEXT,
    ADD COLUMN "acceptedRiskJustification" TEXT,
    ADD COLUMN "acceptedRiskExpiresAt" TIMESTAMP(3),
    ADD COLUMN "scanId" TEXT;
