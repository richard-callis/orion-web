-- SOC2 [H4]: record the owner of each scheduled task so only the owner (or an
-- admin) can modify, delete, or trigger it. Existing rows keep NULL and become
-- admin-only.
--
-- Naming: Prisma applies migration folders in byte order. Legacy folders use
-- numeric prefixes ("0_" .. "9_"), so a bare timestamp ("2026...") would sort
-- BEFORE "24_add_scheduled_tasks" and fail on a fresh database. New migrations
-- use a "t<YYYYMMDDHHMMSS>_" prefix, which sorts after every legacy folder and
-- chronologically among themselves.
ALTER TABLE "ScheduledTask" ADD COLUMN IF NOT EXISTS "createdBy" TEXT;
CREATE INDEX IF NOT EXISTS "ScheduledTask_createdBy_idx" ON "ScheduledTask"("createdBy");
