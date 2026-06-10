-- Add token budget fields to Agent
ALTER TABLE "Agent" ADD COLUMN "tokenBudgetDay"   INTEGER;
ALTER TABLE "Agent" ADD COLUMN "tokenBudgetMonth" INTEGER;

-- Create AgentTokenUsage table
CREATE TABLE "AgentTokenUsage" (
  "id"           TEXT NOT NULL,
  "agentId"      TEXT NOT NULL,
  "taskId"       TEXT NOT NULL,
  "inputTokens"  INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "recordedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AgentTokenUsage_pkey" PRIMARY KEY ("id")
);

-- Add foreign key constraint
ALTER TABLE "AgentTokenUsage"
  ADD CONSTRAINT "AgentTokenUsage_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Create indexes
CREATE INDEX "AgentTokenUsage_agentId_recordedAt_idx" ON "AgentTokenUsage"("agentId", "recordedAt");
CREATE INDEX "AgentTokenUsage_taskId_idx"              ON "AgentTokenUsage"("taskId");
