-- AlterTable
ALTER TABLE "managed_secrets" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "severity" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "rawEvent" JSONB NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityConfig" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecurityConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_profiles" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "activeEnvironments" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_knowledge" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'note',
    "tags" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_knowledge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_knowledge" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'note',
    "tags" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_knowledge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NovaDefinition" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1.0',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "spec" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NovaDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NebulaInstance" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "sourceNovaId" TEXT,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "spec" TEXT NOT NULL,
    "isForked" BOOLEAN NOT NULL DEFAULT false,
    "isInstalled" BOOLEAN NOT NULL DEFAULT true,
    "minimumTier" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NebulaInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HookExecutionLog" (
    "id" TEXT NOT NULL,
    "nebulaId" TEXT NOT NULL,
    "triggerEvent" TEXT NOT NULL,
    "triggerData" TEXT,
    "actionType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "output" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "HookExecutionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillExecutionLog" (
    "id" TEXT NOT NULL,
    "nebulaId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "contextId" TEXT,
    "matchedPattern" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkillExecutionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTrace" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT,
    "taskId" TEXT,
    "step" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "toolName" TEXT,
    "toolArgs" TEXT,
    "toolResult" TEXT,
    "content" TEXT,
    "skillName" TEXT,
    "hookName" TEXT,
    "durationMs" INTEGER,
    "modelUsed" TEXT,
    "systemPromptHash" TEXT,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "costCents" DECIMAL(10,6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentTrace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Eval" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "evalType" TEXT NOT NULL,
    "evaluator" TEXT,
    "rulesetId" TEXT,
    "scores" TEXT NOT NULL,
    "scoreTotal" DOUBLE PRECISION NOT NULL,
    "scoreBreakdown" TEXT,
    "feedback" TEXT,
    "evidence" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Eval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ruleset" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "criteria" TEXT NOT NULL,
    "triggers" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ruleset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentScore" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "scoreTotal" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL,
    "completeness" DOUBLE PRECISION,
    "safety" DOUBLE PRECISION NOT NULL,
    "efficiency" DOUBLE PRECISION,
    "quality" DOUBLE PRECISION,
    "evalCount" INTEGER NOT NULL DEFAULT 0,
    "lastEvalAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentScore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SecurityEvent_environmentId_createdAt_idx" ON "SecurityEvent"("environmentId", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_environmentId_type_acknowledged_idx" ON "SecurityEvent"("environmentId", "type", "acknowledged");

-- CreateIndex
CREATE UNIQUE INDEX "SecurityConfig_environmentId_key_key" ON "SecurityConfig"("environmentId", "key");

-- CreateIndex
CREATE INDEX "agent_profiles_domain_idx" ON "agent_profiles"("domain");

-- CreateIndex
CREATE INDEX "agent_profiles_tags_idx" ON "agent_profiles"("tags");

-- CreateIndex
CREATE UNIQUE INDEX "agent_profiles_agentId_key" ON "agent_profiles"("agentId");

-- CreateIndex
CREATE INDEX "room_knowledge_roomId_idx" ON "room_knowledge"("roomId");

-- CreateIndex
CREATE INDEX "room_knowledge_tags_idx" ON "room_knowledge"("tags");

-- CreateIndex
CREATE INDEX "agent_knowledge_agentId_idx" ON "agent_knowledge"("agentId");

-- CreateIndex
CREATE INDEX "agent_knowledge_tags_idx" ON "agent_knowledge"("tags");

-- CreateIndex
CREATE UNIQUE INDEX "NovaDefinition_name_key" ON "NovaDefinition"("name");

-- CreateIndex
CREATE INDEX "NovaDefinition_category_idx" ON "NovaDefinition"("category");

-- CreateIndex
CREATE INDEX "NebulaInstance_environmentId_category_isInstalled_idx" ON "NebulaInstance"("environmentId", "category", "isInstalled");

-- CreateIndex
CREATE UNIQUE INDEX "NebulaInstance_environmentId_name_key" ON "NebulaInstance"("environmentId", "name");

-- CreateIndex
CREATE INDEX "HookExecutionLog_nebulaId_startedAt_idx" ON "HookExecutionLog"("nebulaId", "startedAt");

-- CreateIndex
CREATE INDEX "HookExecutionLog_status_startedAt_idx" ON "HookExecutionLog"("status", "startedAt");

-- CreateIndex
CREATE INDEX "SkillExecutionLog_nebulaId_createdAt_idx" ON "SkillExecutionLog"("nebulaId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentTrace_conversationId_step_idx" ON "AgentTrace"("conversationId", "step");

-- CreateIndex
CREATE INDEX "AgentTrace_taskId_step_idx" ON "AgentTrace"("taskId", "step");

-- CreateIndex
CREATE INDEX "AgentTrace_type_createdAt_idx" ON "AgentTrace"("type", "createdAt");

-- CreateIndex
CREATE INDEX "AgentTrace_createdAt_idx" ON "AgentTrace"("createdAt");

-- CreateIndex
CREATE INDEX "Eval_environmentId_targetType_targetId_idx" ON "Eval"("environmentId", "targetType", "targetId");

-- CreateIndex
CREATE INDEX "Eval_evalType_createdAt_idx" ON "Eval"("evalType", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Ruleset_name_key" ON "Ruleset"("name");

-- CreateIndex
CREATE INDEX "Ruleset_name_idx" ON "Ruleset"("name");

-- CreateIndex
CREATE UNIQUE INDEX "AgentScore_targetType_targetId_key" ON "AgentScore"("targetType", "targetId");

-- RenameForeignKey (wrapped for idempotency — constraint may already have correct name)
DO $$ BEGIN
  ALTER TABLE "managed_secrets" RENAME CONSTRAINT "managed_secrets_createdby_fkey" TO "managed_secrets_createdBy_fkey";
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "managed_secrets" RENAME CONSTRAINT "managed_secrets_environmentid_fkey" TO "managed_secrets_environmentId_fkey";
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

-- RenameIndex
ALTER INDEX "managed_secrets_environmentid_idx" RENAME TO "managed_secrets_environmentId_idx";

-- AddForeignKey
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityConfig" ADD CONSTRAINT "SecurityConfig_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_knowledge" ADD CONSTRAINT "room_knowledge_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "chat_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_knowledge" ADD CONSTRAINT "agent_knowledge_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NebulaInstance" ADD CONSTRAINT "NebulaInstance_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NebulaInstance" ADD CONSTRAINT "NebulaInstance_sourceNovaId_fkey" FOREIGN KEY ("sourceNovaId") REFERENCES "NovaDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HookExecutionLog" ADD CONSTRAINT "HookExecutionLog_nebulaId_fkey" FOREIGN KEY ("nebulaId") REFERENCES "NebulaInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillExecutionLog" ADD CONSTRAINT "SkillExecutionLog_nebulaId_fkey" FOREIGN KEY ("nebulaId") REFERENCES "NebulaInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Eval" ADD CONSTRAINT "Eval_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentScore" ADD CONSTRAINT "AgentScore_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "managed_secrets_environmentid_idx" RENAME TO "managed_secrets_environmentId_idx";

