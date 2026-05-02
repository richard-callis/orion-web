-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "metadata" JSONB,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "model" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaudeInvocation" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "toolsUsed" JSONB NOT NULL,
    "tokensUsed" INTEGER,
    "durationMs" INTEGER NOT NULL,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaudeInvocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Memory" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "context" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Memory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'human',
    "role" TEXT,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'offline',
    "lastSeen" TIMESTAMP(3),
    "metadata" JSONB,
    "novaId" TEXT,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Environment" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'cluster',
    "description" TEXT,
    "gatewayUrl" TEXT,
    "gatewayToken" TEXT,
    "gatewayVersion" TEXT,
    "status" TEXT NOT NULL DEFAULT 'disconnected',
    "lastSeen" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "gitProvider" TEXT,
    "gitOwner" TEXT,
    "gitRepo" TEXT,
    "argoCdUrl" TEXT,
    "policyConfig" JSONB,
    "kubeconfig" TEXT,

    CONSTRAINT "Environment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitOpsPR" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "prUrl" TEXT NOT NULL,
    "reasoning" TEXT,
    "branch" TEXT NOT NULL,
    "mergedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitOpsPR_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpTool" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "inputSchema" JSONB NOT NULL,
    "execType" TEXT NOT NULL DEFAULT 'builtin',
    "execConfig" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "proposedBy" TEXT,
    "proposedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpTool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentEnvironment" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentEnvironment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnvironmentJoinToken" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fingerprint" TEXT,

    CONSTRAINT "EnvironmentJoinToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentMessage" (
    "id" TEXT NOT NULL,
    "agentId" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'general',
    "content" TEXT NOT NULL,
    "messageType" TEXT NOT NULL DEFAULT 'text',
    "threadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "AgentMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Epic" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "plan" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdBy" TEXT NOT NULL DEFAULT 'admin',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Epic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feature" (
    "id" TEXT NOT NULL,
    "epicId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "plan" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdBy" TEXT NOT NULL DEFAULT 'admin',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Feature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "plan" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "featureId" TEXT,
    "assignedAgent" TEXT,
    "assignedUserId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskEvent" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "content" TEXT,
    "agentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "detail" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "previousHash" TEXT,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedView" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "page" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "SystemPrompt" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'system',
    "content" TEXT NOT NULL,
    "variables" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemPrompt_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "folder" TEXT NOT NULL DEFAULT 'General',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "type" TEXT NOT NULL DEFAULT 'note',
    "tags" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_embeddings" (
    "noteId" TEXT NOT NULL,
    "embedding" TEXT NOT NULL,
    "dimension" INTEGER NOT NULL,
    "modelRef" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "note_embeddings_pkey" PRIMARY KEY ("noteId")
);

-- CreateTable
CREATE TABLE "semantic_connections" (
    "sourceNoteId" TEXT NOT NULL,
    "targetNoteId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "semantic_connections_pkey" PRIMARY KEY ("sourceNoteId","targetNoteId")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "provider" TEXT NOT NULL DEFAULT 'local',
    "passwordHash" TEXT,
    "externalId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastSeen" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "totpSecret" TEXT,
    "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "totpRecoveryCodes" TEXT,
    "totpEnabledAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "hashPrefix" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Default',
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "Bug" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'open',
    "area" TEXT,
    "reportedBy" TEXT NOT NULL DEFAULT 'admin',
    "assignedUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bug_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalModel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKey" TEXT,
    "modelId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "timeoutSecs" INTEGER NOT NULL DEFAULT 120,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OIDCProvider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Authentik',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "issuerUrl" TEXT NOT NULL DEFAULT '',
    "headerMode" BOOLEAN NOT NULL DEFAULT true,
    "groupMapping" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OIDCProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "environmentId" TEXT NOT NULL,
    "minimumTier" TEXT NOT NULL DEFAULT 'viewer',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ToolGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolGroupTool" (
    "toolGroupId" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,

    CONSTRAINT "ToolGroupTool_pkey" PRIMARY KEY ("toolGroupId","toolId")
);

-- CreateTable
CREATE TABLE "AgentGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentGroupMember" (
    "agentGroupId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,

    CONSTRAINT "AgentGroupMember_pkey" PRIMARY KEY ("agentGroupId","agentId")
);

-- CreateTable
CREATE TABLE "AgentGroupToolAccess" (
    "agentGroupId" TEXT NOT NULL,
    "toolGroupId" TEXT NOT NULL,

    CONSTRAINT "AgentGroupToolAccess_pkey" PRIMARY KEY ("agentGroupId","toolGroupId")
);

-- CreateTable
CREATE TABLE "ToolAgentRestriction" (
    "toolId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,

    CONSTRAINT "ToolAgentRestriction_pkey" PRIMARY KEY ("toolId","agentId")
);

-- CreateTable
CREATE TABLE "EnvironmentUserTier" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'viewer',

    CONSTRAINT "EnvironmentUserTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolApprovalRequest" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "toolArgs" JSONB NOT NULL DEFAULT '{}',
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvedBy" TEXT,
    "adminNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ToolApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolExecutionGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolExecutionGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Domain" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'public',
    "notes" TEXT,
    "coreDnsEnvironmentId" TEXT,
    "coreDnsIp" TEXT,
    "coreDnsStatus" TEXT NOT NULL DEFAULT 'none',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Domain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DnsRecord" (
    "id" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "hostnames" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DnsRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngressPoint" (
    "id" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "environmentId" TEXT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'traefik',
    "ip" TEXT,
    "port" INTEGER NOT NULL DEFAULT 443,
    "certManager" BOOLEAN NOT NULL DEFAULT true,
    "clusterIssuer" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngressPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngressRoute" (
    "id" TEXT NOT NULL,
    "ingressPointId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "paths" JSONB NOT NULL DEFAULT '[]',
    "tls" BOOLEAN NOT NULL DEFAULT true,
    "middlewares" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "comment" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "disabledAt" TIMESTAMP(3),
    "disabledBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngressRoute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackgroundJob" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "logs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "environmentId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "BackgroundJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngressMiddleware" (
    "id" TEXT NOT NULL,
    "ingressPointId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngressMiddleware_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nova" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'Other',
    "version" TEXT NOT NULL DEFAULT '1.0.0',
    "source" TEXT NOT NULL DEFAULT 'bundled',
    "config" JSONB NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nova_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NovaDeployment" (
    "id" TEXT NOT NULL,
    "novaId" TEXT NOT NULL,
    "environmentId" TEXT,
    "agentId" TEXT,
    "deployedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'deployed',
    "version" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NovaDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NovaRevision" (
    "id" TEXT NOT NULL,
    "novaId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "diff" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "reasoning" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NovaRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_rooms" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL DEFAULT 'task',
    "taskId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_room_members" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "agentId" TEXT,
    "userId" TEXT,
    "role" TEXT NOT NULL DEFAULT 'member',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReadAt" TIMESTAMP(3),

    CONSTRAINT "chat_room_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "agentId" TEXT,
    "userId" TEXT,
    "senderType" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "attachments" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Memory_conversationId_key_key" ON "Memory"("conversationId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_name_key" ON "Agent"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Environment_name_key" ON "Environment"("name");

-- CreateIndex
CREATE UNIQUE INDEX "GitOpsPR_environmentId_prNumber_key" ON "GitOpsPR"("environmentId", "prNumber");

-- CreateIndex
CREATE UNIQUE INDEX "McpTool_environmentId_name_key" ON "McpTool"("environmentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "AgentEnvironment_agentId_environmentId_key" ON "AgentEnvironment"("agentId", "environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "EnvironmentJoinToken_token_key" ON "EnvironmentJoinToken"("token");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_ipAddress_idx" ON "AuditLog"("ipAddress");

-- CreateIndex
CREATE INDEX "semantic_connections_score_idx" ON "semantic_connections"("score");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_hash_key" ON "api_keys"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "ToolGroup_environmentId_name_key" ON "ToolGroup"("environmentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "AgentGroup_name_key" ON "AgentGroup"("name");

-- CreateIndex
CREATE UNIQUE INDEX "EnvironmentUserTier_userId_environmentId_key" ON "EnvironmentUserTier"("userId", "environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Domain_name_key" ON "Domain"("name");

-- CreateIndex
CREATE UNIQUE INDEX "IngressMiddleware_ingressPointId_name_key" ON "IngressMiddleware"("ingressPointId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "nova_name_key" ON "nova"("name");

-- CreateIndex
CREATE INDEX "NovaDeployment_novaId_idx" ON "NovaDeployment"("novaId");

-- CreateIndex
CREATE UNIQUE INDEX "NovaDeployment_novaId_environmentId_key" ON "NovaDeployment"("novaId", "environmentId");

-- CreateIndex
CREATE INDEX "NovaRevision_novaId_version_idx" ON "NovaRevision"("novaId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "chat_room_members_roomId_agentId_key" ON "chat_room_members"("roomId", "agentId");

-- CreateIndex
CREATE UNIQUE INDEX "chat_room_members_roomId_userId_key" ON "chat_room_members"("roomId", "userId");

-- CreateIndex
CREATE INDEX "chat_messages_roomId_createdAt_idx" ON "chat_messages"("roomId", "createdAt");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaudeInvocation" ADD CONSTRAINT "ClaudeInvocation_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_novaId_fkey" FOREIGN KEY ("novaId") REFERENCES "nova"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitOpsPR" ADD CONSTRAINT "GitOpsPR_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpTool" ADD CONSTRAINT "McpTool_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentEnvironment" ADD CONSTRAINT "AgentEnvironment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentEnvironment" ADD CONSTRAINT "AgentEnvironment_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvironmentJoinToken" ADD CONSTRAINT "EnvironmentJoinToken_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMessage" ADD CONSTRAINT "AgentMessage_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feature" ADD CONSTRAINT "Feature_epicId_fkey" FOREIGN KEY ("epicId") REFERENCES "Epic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "Feature"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assignedAgent_fkey" FOREIGN KEY ("assignedAgent") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskEvent" ADD CONSTRAINT "TaskEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_embeddings" ADD CONSTRAINT "note_embeddings_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bug" ADD CONSTRAINT "Bug_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolGroup" ADD CONSTRAINT "ToolGroup_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolGroupTool" ADD CONSTRAINT "ToolGroupTool_toolGroupId_fkey" FOREIGN KEY ("toolGroupId") REFERENCES "ToolGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolGroupTool" ADD CONSTRAINT "ToolGroupTool_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "McpTool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentGroupMember" ADD CONSTRAINT "AgentGroupMember_agentGroupId_fkey" FOREIGN KEY ("agentGroupId") REFERENCES "AgentGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentGroupMember" ADD CONSTRAINT "AgentGroupMember_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentGroupToolAccess" ADD CONSTRAINT "AgentGroupToolAccess_agentGroupId_fkey" FOREIGN KEY ("agentGroupId") REFERENCES "AgentGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentGroupToolAccess" ADD CONSTRAINT "AgentGroupToolAccess_toolGroupId_fkey" FOREIGN KEY ("toolGroupId") REFERENCES "ToolGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolAgentRestriction" ADD CONSTRAINT "ToolAgentRestriction_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "McpTool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolAgentRestriction" ADD CONSTRAINT "ToolAgentRestriction_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvironmentUserTier" ADD CONSTRAINT "EnvironmentUserTier_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvironmentUserTier" ADD CONSTRAINT "EnvironmentUserTier_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_coreDnsEnvironmentId_fkey" FOREIGN KEY ("coreDnsEnvironmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DnsRecord" ADD CONSTRAINT "DnsRecord_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngressPoint" ADD CONSTRAINT "IngressPoint_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngressPoint" ADD CONSTRAINT "IngressPoint_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngressRoute" ADD CONSTRAINT "IngressRoute_ingressPointId_fkey" FOREIGN KEY ("ingressPointId") REFERENCES "IngressPoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngressMiddleware" ADD CONSTRAINT "IngressMiddleware_ingressPointId_fkey" FOREIGN KEY ("ingressPointId") REFERENCES "IngressPoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NovaDeployment" ADD CONSTRAINT "NovaDeployment_novaId_fkey" FOREIGN KEY ("novaId") REFERENCES "nova"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NovaDeployment" ADD CONSTRAINT "NovaDeployment_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NovaDeployment" ADD CONSTRAINT "NovaDeployment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NovaRevision" ADD CONSTRAINT "NovaRevision_novaId_fkey" FOREIGN KEY ("novaId") REFERENCES "nova"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_rooms" ADD CONSTRAINT "chat_rooms_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_room_members" ADD CONSTRAINT "chat_room_members_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "chat_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_room_members" ADD CONSTRAINT "chat_room_members_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_room_members" ADD CONSTRAINT "chat_room_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "chat_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

