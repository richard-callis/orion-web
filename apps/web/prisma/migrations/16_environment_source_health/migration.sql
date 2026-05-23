-- Migration: per-environment source health tracking (Phase 2)
--
-- Adds EnvironmentSourceHealth — separate from the existing SourceHealth table
-- which Phase 1 uses for global/host sources. This table is keyed by
-- (environmentId, source) so each managed environment tracks its own Falco
-- and K8s-events ingestion health independently.

CREATE TABLE "EnvironmentSourceHealth" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "lastWatermark" TEXT,
    "staleAfterMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnvironmentSourceHealth_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EnvironmentSourceHealth_environmentId_source_key"
    ON "EnvironmentSourceHealth"("environmentId", "source");

CREATE INDEX "EnvironmentSourceHealth_source_idx"
    ON "EnvironmentSourceHealth"("source");

CREATE INDEX "EnvironmentSourceHealth_environmentId_idx"
    ON "EnvironmentSourceHealth"("environmentId");

ALTER TABLE "EnvironmentSourceHealth"
    ADD CONSTRAINT "EnvironmentSourceHealth_environmentId_fkey"
    FOREIGN KEY ("environmentId") REFERENCES "Environment"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
