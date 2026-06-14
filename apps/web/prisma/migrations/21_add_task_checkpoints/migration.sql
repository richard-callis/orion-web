CREATE TABLE IF NOT EXISTS "TaskCheckpoint" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "toolName" TEXT NOT NULL,
    "argsHash" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskCheckpoint_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TaskCheckpoint_taskId_stepIndex_key" ON "TaskCheckpoint"("taskId", "stepIndex");
CREATE INDEX "TaskCheckpoint_taskId_idx" ON "TaskCheckpoint"("taskId");
