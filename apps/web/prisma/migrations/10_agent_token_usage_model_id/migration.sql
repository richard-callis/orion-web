-- Add modelId to AgentTokenUsage for per-model cost breakdown
ALTER TABLE "AgentTokenUsage" ADD COLUMN "modelId" TEXT;
CREATE INDEX "AgentTokenUsage_modelId_idx" ON "AgentTokenUsage"("modelId");
