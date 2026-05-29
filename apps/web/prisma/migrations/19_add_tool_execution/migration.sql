-- Add ToolExecution table for tracking executor tool calls
-- Tracks shell_exec, file_read, and system_info execution with Warden approval gating

CREATE TABLE "ToolExecution" (
  "id" TEXT NOT NULL,
  "executionId" TEXT NOT NULL,
  "environmentId" TEXT,
  "tool" TEXT NOT NULL,
  "args" JSONB NOT NULL,
  "actorId" TEXT NOT NULL,
  "actorType" TEXT NOT NULL,
  "riskTier" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "exitCode" INTEGER,
  "output" TEXT,
  "durationMs" INTEGER,
  "reviewerId" TEXT,
  "reviewDecision" TEXT,
  "reviewedAt" TIMESTAMPTZ(3),
  "expiresAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT (now()),
  "completedAt" TIMESTAMPTZ(3),

  CONSTRAINT "ToolExecution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ToolExecution_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX "ToolExecution_executionId_key" ON "ToolExecution"("executionId");
CREATE INDEX "ToolExecution_actorId_createdAt" ON "ToolExecution"("actorId", "createdAt");
CREATE INDEX "ToolExecution_status_createdAt" ON "ToolExecution"("status", "createdAt");
CREATE INDEX "ToolExecution_tool_createdAt" ON "ToolExecution"("tool", "createdAt");
CREATE INDEX "ToolExecution_expiresAt" ON "ToolExecution"("expiresAt");
