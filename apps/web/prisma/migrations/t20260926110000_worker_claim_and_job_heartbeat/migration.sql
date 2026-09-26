-- Atomic task claim + heartbeat (worker) and BackgroundJob ownership/heartbeat/idempotency.
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "claimedBy" TEXT;
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3);
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "heartbeatAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "Task_status_heartbeatAt_idx" ON "Task"("status", "heartbeatAt");

ALTER TABLE "BackgroundJob" ADD COLUMN IF NOT EXISTS "ownerId" TEXT;
ALTER TABLE "BackgroundJob" ADD COLUMN IF NOT EXISTS "heartbeatAt" TIMESTAMP(3);
ALTER TABLE "BackgroundJob" ADD COLUMN IF NOT EXISTS "dedupeKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "BackgroundJob_dedupeKey_key" ON "BackgroundJob"("dedupeKey");
CREATE INDEX IF NOT EXISTS "BackgroundJob_status_heartbeatAt_idx" ON "BackgroundJob"("status", "heartbeatAt");
