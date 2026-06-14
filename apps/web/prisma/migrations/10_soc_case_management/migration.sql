-- SOC Case Management Schema
-- Adds investigation tracking: cases, notes, observables, timeline, audit log.
-- All changes are additive — zero data loss on existing data.

-- ── Enums ──────────────────────────────────────────────────────────────────────

CREATE TYPE "InvestigationStatus" AS ENUM ('open', 'active', 'suspended', 'resolved', 'closed');
CREATE TYPE "ResolutionType" AS ENUM ('true_positive', 'false_positive', 'benign', 'inconclusive');
CREATE TYPE "TLP" AS ENUM ('white', 'green', 'amber', 'red');
CREATE TYPE "ObservableCategory" AS ENUM ('ipv4', 'ipv6', 'domain', 'url', 'file_hash_md5', 'file_hash_sha1', 'file_hash_sha256', 'mac_address', 'email', 'username', 'file_path', 'registry_key', 'mutex', 'asn');
CREATE TYPE "ObservableVerdict" AS ENUM ('malicious', 'suspicious', 'benign', 'unknown');
CREATE TYPE "ObservableRole" AS ENUM ('ioc', 'artifact', 'infrastructure');

-- ── Investigation table ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "Investigation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "status" "InvestigationStatus" NOT NULL DEFAULT 'open',
  "severity" INTEGER NOT NULL,
  "tlp" "TLP" NOT NULL DEFAULT 'amber',
  "pap" INTEGER NOT NULL DEFAULT 2,
  "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT (now()),
  "resolvedAt" TIMESTAMPTZ(3),
  "closedAt" TIMESTAMPTZ(3),
  "resolution" TEXT,
  "resolutionType" "ResolutionType",
  "assignedTo" TEXT,
  "createdBy" TEXT NOT NULL,
  "tags" TEXT[] NOT NULL DEFAULT '{}',
  "dueAt" TIMESTAMPTZ(3),
  "mitreAttackIds" TEXT[] NOT NULL DEFAULT '{}',
  "externalId" TEXT,
  "externalSystem" TEXT,
  "lastSyncedAt" TIMESTAMPTZ(3),
  "syncVersion" INTEGER NOT NULL DEFAULT 0,
  "syncSource" TEXT,
  "timeToDetect" INTEGER,
  "timeToRespond" INTEGER,
  "timeToResolve" INTEGER,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT (now()),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "Investigation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Investigation_status" ON "Investigation"("status");
CREATE INDEX "Investigation_createdAt" ON "Investigation"("createdAt");
CREATE INDEX "Investigation_externalId" ON "Investigation"("externalId");

-- ── InvestigationNote table ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "InvestigationNote" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "investigationId" UUID NOT NULL,
  "content" TEXT NOT NULL,
  "author" TEXT NOT NULL,
  "authorType" TEXT NOT NULL,
  "isDraft" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT (now()),
  "updatedAt" TIMESTAMPTZ(3),
  "searchVector" tsvector,

  CONSTRAINT "InvestigationNote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InvestigationNote_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id") ON DELETE CASCADE
);

CREATE INDEX "InvestigationNote_investigationId_createdAt" ON "InvestigationNote"("investigationId", "createdAt");
CREATE INDEX "InvestigationNote_investigationId_authorType" ON "InvestigationNote"("investigationId", "authorType");

-- GIN index for full-text search on notes (successes up to 500ms on 10k notes)
CREATE INDEX "InvestigationNote_searchVector_idx" ON "InvestigationNote" USING gin("searchVector");

-- ── InvestigationObservable table ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "InvestigationObservable" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "investigationId" UUID NOT NULL,
  "value" TEXT NOT NULL,
  "displayValue" TEXT NOT NULL,
  "category" "ObservableCategory" NOT NULL,
  "role" "ObservableRole" NOT NULL DEFAULT 'ioc',
  "verdict" "ObservableVerdict" NOT NULL DEFAULT 'unknown',
  "verdictBy" TEXT,
  "verdictAt" TIMESTAMPTZ(3),
  "confidence" INTEGER NOT NULL DEFAULT 0,
  "severity" INTEGER NOT NULL DEFAULT 0,
  "firstSeen" TIMESTAMPTZ(3) NOT NULL DEFAULT (now()),
  "lastSeen" TIMESTAMPTZ(3) NOT NULL,
  "context" TEXT,
  "resolved" BOOLEAN NOT NULL DEFAULT false,
  "threatIntelMatch" JSONB,
  "externalId" TEXT,
  "lastSyncedAt" TIMESTAMPTZ(3),

  CONSTRAINT "InvestigationObservable_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InvestigationObservable_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id") ON DELETE CASCADE
);

-- Unique constraint: one observable per investigation per (value, category)
CREATE UNIQUE INDEX "InvestigationObservable_investigationId_value_category_key"
  ON "InvestigationObservable"("investigationId", "value", "category");
CREATE INDEX "InvestigationObservable_value" ON "InvestigationObservable"("value");
CREATE INDEX "InvestigationObservable_category" ON "InvestigationObservable"("category");
CREATE INDEX "InvestigationObservable_verdict" ON "InvestigationObservable"("verdict");

-- ── InvestigationTimeline table ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "InvestigationTimeline" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "investigationId" UUID NOT NULL,
  "eventTime" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT (now()),
  "eventType" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "source" TEXT NOT NULL,
  "isPinned" BOOLEAN NOT NULL DEFAULT false,
  "payload" JSONB,

  CONSTRAINT "InvestigationTimeline_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InvestigationTimeline_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id") ON DELETE CASCADE
);

CREATE INDEX "InvestigationTimeline_investigationId_eventTime" ON "InvestigationTimeline"("investigationId", "eventTime");
CREATE INDEX "InvestigationTimeline_investigationId_eventType" ON "InvestigationTimeline"("investigationId", "eventType");

-- ── InvestigationAudit table ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "InvestigationAudit" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "investigationId" UUID NOT NULL,
  "actorId" TEXT NOT NULL,
  "actorType" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "before" JSONB,
  "after" JSONB,
  "timestamp" TIMESTAMPTZ(3) NOT NULL DEFAULT (now()),

  CONSTRAINT "InvestigationAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InvestigationAudit_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id") ON DELETE CASCADE
);

CREATE INDEX "InvestigationAudit_investigationId_timestamp" ON "InvestigationAudit"("investigationId", "timestamp");

-- ── Incident.back-reference to Investigation ──────────────────────────────────

ALTER TABLE "Incident" ADD COLUMN "investigationId" UUID;
CREATE INDEX "Incident_investigationId" ON "Incident"("investigationId");
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_investigationId_fkey"
  FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id") ON DELETE SET NULL;
