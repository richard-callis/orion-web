-- Migration: cascade delete on SecurityEvent.incidentId and ActionAudit.incidentId
--
-- Changes both FK constraints from ON DELETE SET NULL to ON DELETE CASCADE.
-- When an Incident is purged by the retention job, all related SecurityEvent
-- and ActionAudit rows are automatically deleted, avoiding orphaned rows.
--
-- This is required because the retention job (PR #414) deletes old Incidents.
-- With SetNull, purging an Incident left ActionAudit rows with incidentId=NULL,
-- breaking the drilldown UI's ability to join events→audits→incident.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS before ADD CONSTRAINT.

-- SecurityEvent.incident → Cascade
DO $$ BEGIN
  ALTER TABLE "SecurityEvent" DROP CONSTRAINT IF EXISTS "SecurityEvent_incidentId_fkey";
END $$;

DO $$ BEGIN
  ALTER TABLE "SecurityEvent"
    ADD CONSTRAINT "SecurityEvent_incidentId_fkey"
    FOREIGN KEY ("incidentId")
    REFERENCES "Incident"("id")
    ON DELETE CASCADE;
END $$;

-- ActionAudit.incident → Cascade
DO $$ BEGIN
  ALTER TABLE "ActionAudit" DROP CONSTRAINT IF EXISTS "ActionAudit_incidentId_fkey";
END $$;

DO $$ BEGIN
  ALTER TABLE "ActionAudit"
    ADD CONSTRAINT "ActionAudit_incidentId_fkey"
    FOREIGN KEY ("incidentId")
    REFERENCES "Incident"("id")
    ON DELETE CASCADE;
END $$;
