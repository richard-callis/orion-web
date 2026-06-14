-- CreateTable
CREATE TABLE IF NOT EXISTS "EvalSuite" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "agentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvalSuite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "EvalCase" (
    "id" TEXT NOT NULL,
    "suiteId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "expectedOutput" TEXT,
    "assertions" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvalCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "EvalRun" (
    "id" TEXT NOT NULL,
    "suiteId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "scoreTotal" DOUBLE PRECISION,
    "passCount" INTEGER NOT NULL DEFAULT 0,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvalRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "EvalCaseResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "taskId" TEXT,
    "passed" BOOLEAN,
    "score" DOUBLE PRECISION,
    "output" TEXT,
    "assertions" TEXT NOT NULL,
    "judgeReason" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvalCaseResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EvalSuite_name_key" ON "EvalSuite"("name");

-- CreateIndex
CREATE INDEX "EvalSuite_agentId_idx" ON "EvalSuite"("agentId");

-- CreateIndex
CREATE INDEX "EvalCase_suiteId_idx" ON "EvalCase"("suiteId");

-- CreateIndex
CREATE INDEX "EvalRun_suiteId_idx" ON "EvalRun"("suiteId");

-- CreateIndex
CREATE INDEX "EvalRun_agentId_idx" ON "EvalRun"("agentId");

-- CreateIndex
CREATE INDEX "EvalCaseResult_runId_idx" ON "EvalCaseResult"("runId");

-- CreateIndex
CREATE INDEX "EvalCaseResult_caseId_idx" ON "EvalCaseResult"("caseId");

-- AddForeignKey
ALTER TABLE "EvalSuite" ADD CONSTRAINT "EvalSuite_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalCase" ADD CONSTRAINT "EvalCase_suiteId_fkey" FOREIGN KEY ("suiteId") REFERENCES "EvalSuite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalRun" ADD CONSTRAINT "EvalRun_suiteId_fkey" FOREIGN KEY ("suiteId") REFERENCES "EvalSuite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalRun" ADD CONSTRAINT "EvalRun_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalCaseResult" ADD CONSTRAINT "EvalCaseResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EvalRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvalCaseResult" ADD CONSTRAINT "EvalCaseResult_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "EvalCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
