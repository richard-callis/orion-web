-- Add ScheduledTask table for cron-style recurring task scheduling

CREATE TABLE "ScheduledTask" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "agentId" TEXT NOT NULL,
  "cronExpr" TEXT NOT NULL,
  "taskTitle" TEXT NOT NULL,
  "taskDesc" TEXT,
  "taskMeta" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "lastRunAt" TIMESTAMPTZ(3),
  "nextRunAt" TIMESTAMPTZ(3),
  "lastTaskId" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT (now()),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "ScheduledTask_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ScheduledTask_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "ScheduledTask_agentId_idx" ON "ScheduledTask"("agentId");
CREATE INDEX "ScheduledTask_nextRunAt_enabled_idx" ON "ScheduledTask"("nextRunAt", "enabled");
