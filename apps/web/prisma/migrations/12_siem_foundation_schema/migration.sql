-- AlterTable: Add SIEM fields to SecurityEvent
ALTER TABLE "SecurityEvent" ADD COLUMN "incidentId" TEXT;
ALTER TABLE "SecurityEvent" ADD COLUMN "firstSeen" TIMESTAMP(3);
ALTER TABLE "SecurityEvent" ADD COLUMN "lastSeen" TIMESTAMP(3);

-- CreateTable: Incident
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "severity" INTEGER NOT NULL,
    "rootCauseSummary" TEXT,
    "attackerKey" TEXT,
    "hostKey" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ActionAudit
CREATE TABLE "ActionAudit" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT,
    "incidentId" TEXT,
    "policyId" TEXT,
    "actionType" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "proposedBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "status" TEXT NOT NULL,
    "payload" JSONB,
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ActionPolicy
CREATE TABLE "ActionPolicy" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT,
    "actionType" TEXT NOT NULL,
    "defaultTier" TEXT NOT NULL,
    "targetPatterns" JSONB,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable: CorrelationRule
CREATE TABLE "CorrelationRule" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "ruleType" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "severity" INTEGER NOT NULL,
    "window" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CorrelationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable: SourceHealth
CREATE TABLE "SourceHealth" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT,
    "source" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "lastWatermark" TIMESTAMP(3),
    "staleAfterMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceHealth_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Suppression
CREATE TABLE "Suppression" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT,
    "matchPattern" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Suppression_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: SecurityEvent incidentId
CREATE INDEX "SecurityEvent_incidentId_idx" ON "SecurityEvent"("incidentId");

-- CreateIndex: ActionPolicy unique on actionType
CREATE UNIQUE INDEX "ActionPolicy_actionType_key" ON "ActionPolicy"("actionType");

-- CreateIndex: CorrelationRule unique on name
CREATE UNIQUE INDEX "CorrelationRule_name_key" ON "CorrelationRule"("name");

-- CreateIndex: SourceHealth unique on source
CREATE UNIQUE INDEX "SourceHealth_source_key" ON "SourceHealth"("source");

-- AddForeignKey: SecurityEvent.incidentId → Incident.id
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: Incident.environmentId → Environment.id
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: ActionAudit.environmentId → Environment.id
ALTER TABLE "ActionAudit" ADD CONSTRAINT "ActionAudit_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: ActionAudit.incidentId → Incident.id
ALTER TABLE "ActionAudit" ADD CONSTRAINT "ActionAudit_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: ActionAudit.policyId → ActionPolicy.id
ALTER TABLE "ActionAudit" ADD CONSTRAINT "ActionAudit_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "ActionPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: ActionPolicy.environmentId → Environment.id
ALTER TABLE "ActionPolicy" ADD CONSTRAINT "ActionPolicy_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: CorrelationRule.environmentId → Environment.id
ALTER TABLE "CorrelationRule" ADD CONSTRAINT "CorrelationRule_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: SourceHealth.environmentId → Environment.id
ALTER TABLE "SourceHealth" ADD CONSTRAINT "SourceHealth_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: Suppression.environmentId → Environment.id
ALTER TABLE "Suppression" ADD CONSTRAINT "Suppression_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex: Incident composite indexes
CREATE INDEX "Incident_environmentId_status_idx" ON "Incident"("environmentId", "status");
CREATE INDEX "Incident_environmentId_severity_idx" ON "Incident"("environmentId", "severity");

-- CreateIndex: ActionAudit composite indexes
CREATE INDEX "ActionAudit_incidentId_idx" ON "ActionAudit"("incidentId");
CREATE INDEX "ActionAudit_status_idx" ON "ActionAudit"("status");
CREATE INDEX "ActionAudit_tier_idx" ON "ActionAudit"("tier");

-- CreateIndex: ActionPolicy environment index
CREATE INDEX "ActionPolicy_environmentId_idx" ON "ActionPolicy"("environmentId");

-- CreateIndex: CorrelationRule indexes
CREATE INDEX "CorrelationRule_enabled_idx" ON "CorrelationRule"("enabled");
CREATE INDEX "CorrelationRule_environmentId_idx" ON "CorrelationRule"("environmentId");

-- CreateIndex: SourceHealth indexes
CREATE INDEX "SourceHealth_source_idx" ON "SourceHealth"("source");
CREATE INDEX "SourceHealth_environmentId_idx" ON "SourceHealth"("environmentId");

-- CreateIndex: Suppression indexes
CREATE INDEX "Suppression_expiresAt_idx" ON "Suppression"("expiresAt");
CREATE INDEX "Suppression_environmentId_idx" ON "Suppression"("environmentId");
