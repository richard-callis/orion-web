-- Add federation fields to Environment
ALTER TABLE "Environment" ADD COLUMN IF NOT EXISTS "federationRole"  TEXT;
ALTER TABLE "Environment" ADD COLUMN IF NOT EXISTS "federationToken" TEXT;
ALTER TABLE "Environment" ADD COLUMN IF NOT EXISTS "spokeUrl"        TEXT;
ALTER TABLE "Environment" ADD COLUMN IF NOT EXISTS "hubUrl"          TEXT;

-- Add FederatedDispatch model
CREATE TABLE IF NOT EXISTS "FederatedDispatch" (
    "id"             TEXT NOT NULL,
    "taskId"         TEXT NOT NULL,
    "targetEnvId"    TEXT NOT NULL,
    "spokeUrl"       TEXT NOT NULL,
    "status"         TEXT NOT NULL DEFAULT 'dispatched',
    "dispatchedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "completedAt"    TIMESTAMP(3),

    CONSTRAINT "FederatedDispatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FederatedDispatch_taskId_key" ON "FederatedDispatch"("taskId");
CREATE INDEX IF NOT EXISTS "FederatedDispatch_targetEnvId_idx" ON "FederatedDispatch"("targetEnvId");

ALTER TABLE "FederatedDispatch" ADD CONSTRAINT "FederatedDispatch_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
