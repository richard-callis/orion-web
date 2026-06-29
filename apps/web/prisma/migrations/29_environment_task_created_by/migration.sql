-- Environment
ALTER TABLE "Environment" ADD COLUMN "createdBy" TEXT;
ALTER TABLE "Environment" ADD CONSTRAINT "Environment_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Environment_createdBy_idx" ON "Environment"("createdBy");

-- Task: make nullable, add NOT VALID FK (existing rows may have 'gateway'/'vuln-scanner' strings, not real user IDs)
ALTER TABLE "Task" ALTER COLUMN "createdBy" DROP NOT NULL;
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
CREATE INDEX IF NOT EXISTS "Task_createdBy_idx" ON "Task"("createdBy");
