-- Migration: SecurityEvent.scannedAt for Phase 3 vulnerability scanner
-- (PR13 follow-up review fix).
--
-- Replaces the SecurityConfig probe-row scheme that runEventTriggeredScan
-- was using to track "already scanned" docker.image.pull events. The probe
-- scheme grew unbounded (one row per event forever) and the lookup query
-- (findUnique by `key` alone) didn't match SecurityConfig's actual unique
-- key (envId, key).
--
-- Nullable column — pre-existing rows are NULL = never scanned. The
-- event-triggered scan loop filters by type IN (...) AND scannedAt IS NULL,
-- which the new index serves cheaply.

ALTER TABLE "SecurityEvent" ADD COLUMN "scannedAt" TIMESTAMP(3);

CREATE INDEX "SecurityEvent_type_scannedAt_idx" ON "SecurityEvent"("type", "scannedAt");
