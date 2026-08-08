-- AddColumn: track who/what authored a NebulaInstance (skill/hook) — human (default),
-- agent (self-saved via save_skill tool), or dream (auto-crafted by Dream).
ALTER TABLE "NebulaInstance" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'human';
ALTER TABLE "NebulaInstance" ADD COLUMN "createdByAgentId" TEXT;

ALTER TABLE "NebulaInstance"
  ADD CONSTRAINT "NebulaInstance_createdByAgentId_fkey"
  FOREIGN KEY ("createdByAgentId") REFERENCES "Agent"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "NebulaInstance_createdByAgentId_idx" ON "NebulaInstance"("createdByAgentId");
