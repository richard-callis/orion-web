CREATE TABLE "JobRun" (
  "id"           TEXT NOT NULL,
  "source"       TEXT NOT NULL,
  "sourceId"     TEXT NOT NULL,
  "sourceName"   TEXT NOT NULL,
  "agentId"      TEXT,
  "taskId"       TEXT,
  "status"       TEXT NOT NULL DEFAULT 'running',
  "startedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt"   TIMESTAMP(3),
  "errorMessage" TEXT,
  CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "JobRun_source_startedAt_idx"   ON "JobRun"("source",   "startedAt");
CREATE INDEX "JobRun_sourceId_startedAt_idx" ON "JobRun"("sourceId", "startedAt");
