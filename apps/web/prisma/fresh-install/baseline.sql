-- ORION fresh-install baseline
--
-- Net schema produced by the legacy migrations listed in legacy-migrations.txt.
-- Those migrations cannot be replayed on an empty database in Prisma's
-- (string-sorted) order, and some were generated against a hand-migrated
-- production database, so fresh installs apply this file instead and then
-- record every legacy migration as applied (see apply.mjs).
--
-- Generated once from schema.prisma at the legacy-chain end state with
--   prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
-- plus the raw-SQL objects Prisma cannot express (appended/patched below).
-- It is FROZEN: never edit it for new schema changes. New changes go in new
-- timestamped migrations under prisma/migrations/ (see prisma/MIGRATIONS.md).

CREATE EXTENSION IF NOT EXISTS vector;

-- Marker read by apply.mjs: this database was created from the baseline.
CREATE TABLE "_orion_baseline" (
    "version" INTEGER NOT NULL PRIMARY KEY,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "_orion_baseline" ("version") VALUES (1);

-- CreateEnum
CREATE TYPE "ContainmentStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "VulnStatus" AS ENUM ('open', 'fixed', 'accepted', 'false_positive');

-- CreateEnum
CREATE TYPE "InvestigationStatus" AS ENUM ('open', 'active', 'suspended', 'resolved', 'closed');

-- CreateEnum
CREATE TYPE "ResolutionType" AS ENUM ('true_positive', 'false_positive', 'benign', 'inconclusive');

-- CreateEnum
CREATE TYPE "TLP" AS ENUM ('white', 'green', 'amber', 'red');

-- CreateEnum
CREATE TYPE "ObservableCategory" AS ENUM ('ipv4', 'ipv6', 'domain', 'url', 'file_hash_md5', 'file_hash_sha1', 'file_hash_sha256', 'mac_address', 'email', 'username', 'file_path', 'registry_key', 'mutex', 'asn');

-- CreateEnum
CREATE TYPE "ObservableVerdict" AS ENUM ('malicious', 'suspicious', 'benign', 'unknown');

-- CreateEnum
CREATE TYPE "ObservableRole" AS ENUM ('ioc', 'artifact', 'infrastructure');

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
    "tokenBudgetDay" INTEGER,
    "tokenBudgetMonth" INTEGER,
    "createdBy" TEXT,
    "mcpToken" TEXT,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTokenUsage" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "taskId" TEXT,
    "modelId" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentTokenUsage_pkey" PRIMARY KEY ("id")
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
    "monitoringConfig" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "gitProvider" TEXT,
    "gitOwner" TEXT,
    "gitRepo" TEXT,
    "repoPath" TEXT,
    "vaultPathPrefix" TEXT,
    "argoCdUrl" TEXT,
    "policyConfig" JSONB,
    "kubeconfig" TEXT,
    "federationRole" TEXT,
    "federationToken" TEXT,
    "spokeUrl" TEXT,
    "hubUrl" TEXT,

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
    "planApprovedBy" TEXT,
    "planApprovedAt" TIMESTAMP(3),

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
    "planApprovedBy" TEXT,
    "planApprovedAt" TIMESTAMP(3),

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
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "planProgress" INTEGER,
    "planApprovedBy" TEXT,
    "planApprovedAt" TIMESTAMP(3),
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "nextRetryAt" TIMESTAMP(3),
    "dependsOn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "wave" INTEGER,
    "metadata" JSONB,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FederatedDispatch" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "targetEnvId" TEXT NOT NULL,
    "spokeUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'dispatched',
    "dispatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastPolledAt" TIMESTAMP(3),
    "failCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "FederatedDispatch_pkey" PRIMARY KEY ("id")
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
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "searchVector" tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
        setweight(to_tsvector('english', coalesce("content", '')), 'B')
    ) STORED,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_embeddings" (
    "noteId" TEXT NOT NULL,
    "embedding" vector(768) NOT NULL,
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
    "totpSecretEncrypted" TEXT,
    "totpRecoveryCodesEncrypted" TEXT,
    "githubTokenEncrypted" TEXT,
    "githubUsername" TEXT,
    "githubAllowedRepos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastUsedTotpAt" TIMESTAMP(3),

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
    "selfHosted" BOOLEAN NOT NULL DEFAULT false,
    "inputPricePer1M" DECIMAL(10,6),
    "outputPricePer1M" DECIMAL(10,6),
    "timeoutSecs" INTEGER NOT NULL DEFAULT 120,
    "maxTokens" INTEGER,
    "contextSize" INTEGER,
    "temperature" DOUBLE PRECISION,
    "topP" DOUBLE PRECISION,
    "minP" DOUBLE PRECISION,
    "repeatPenalty" DOUBLE PRECISION,
    "seed" INTEGER,
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
    "featureId" TEXT,
    "epicId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tokenCount" INTEGER NOT NULL DEFAULT 0,
    "tokenLimit" INTEGER,
    "metadata" JSONB,

    CONSTRAINT "chat_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_goals" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "completionSummary" TEXT,
    "startMessageId" TEXT,
    "setBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "room_goals_pkey" PRIMARY KEY ("id")
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
    "taskId" TEXT,
    "senderType" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "attachments" JSONB,
    "incidentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "managed_secrets" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "namespace" TEXT NOT NULL DEFAULT 'default',
    "description" TEXT,
    "secretStore" TEXT NOT NULL DEFAULT 'vault-backend',
    "secretStoreKind" TEXT NOT NULL DEFAULT 'ClusterSecretStore',
    "remoteRef" TEXT NOT NULL,
    "targetSecretName" TEXT,
    "refreshInterval" TEXT NOT NULL DEFAULT '1h',
    "dataKeys" JSONB NOT NULL DEFAULT '[]',
    "tags" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "statusMessage" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "managed_secrets_pkey" PRIMARY KEY ("id")
);

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
    "incidentId" TEXT,
    "firstSeen" TIMESTAMP(3),
    "lastSeen" TIMESTAMP(3),
    "scannedAt" TIMESTAMP(3),
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
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "severity" INTEGER NOT NULL,
    "rootCauseSummary" TEXT,
    "attackerKey" TEXT,
    "hostKey" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "investigationId" TEXT,
    "triageDispatchedAt" TIMESTAMP(3),

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContainmentRequest" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "justification" TEXT NOT NULL,
    "status" "ContainmentStatus" NOT NULL DEFAULT 'pending',
    "requestedBy" TEXT NOT NULL,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContainmentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionAudit" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT,
    "incidentId" TEXT,
    "policyId" TEXT,
    "actionType" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "proposedBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "status" TEXT NOT NULL,
    "payload" JSONB,
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionPolicy" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT,
    "actionType" TEXT NOT NULL,
    "defaultTier" TEXT NOT NULL,
    "targetPatterns" JSONB,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CorrelationRule" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "ruleType" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "severity" INTEGER NOT NULL,
    "window" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CorrelationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceHealth" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT,
    "source" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "lastWatermark" TIMESTAMP(3),
    "staleAfterMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceHealth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnvironmentSourceHealth" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "lastWatermark" TEXT,
    "staleAfterMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnvironmentSourceHealth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VulnerabilityFinding" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "packageName" TEXT NOT NULL,
    "packageVersion" TEXT NOT NULL,
    "fixedVersion" TEXT,
    "cveId" TEXT NOT NULL,
    "cvssScore" DOUBLE PRECISION,
    "cvssVector" TEXT,
    "attackVector" TEXT,
    "attackComplexity" TEXT,
    "epssScore" DOUBLE PRECISION,
    "epssPercentile" DOUBLE PRECISION,
    "isKev" BOOLEAN NOT NULL DEFAULT false,
    "kevDueDate" TIMESTAMP(3),
    "severity" INTEGER NOT NULL,
    "status" "VulnStatus" NOT NULL DEFAULT 'open',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "fixedAt" TIMESTAMP(3),
    "rawScanner" JSONB NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "fixAvailable" BOOLEAN NOT NULL DEFAULT false,
    "taskId" TEXT,
    "acceptedRiskJustification" TEXT,
    "acceptedRiskExpiresAt" TIMESTAMP(3),
    "scanId" TEXT,

    CONSTRAINT "VulnerabilityFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VulnerabilityScan" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "driver" TEXT NOT NULL DEFAULT 'trivy',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "triggeredBy" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "findingsCreated" INTEGER NOT NULL DEFAULT 0,
    "findingsEscalated" INTEGER NOT NULL DEFAULT 0,
    "findingsFixed" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "VulnerabilityScan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Suppression" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT,
    "matchPattern" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Suppression_pkey" PRIMARY KEY ("id")
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
    "source" TEXT NOT NULL DEFAULT 'human',
    "createdByAgentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NebulaInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nebula_embeddings" (
    "nebulaId" TEXT NOT NULL,
    "embedding" vector(768) NOT NULL,
    "dimension" INTEGER NOT NULL,
    "modelRef" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nebula_embeddings_pkey" PRIMARY KEY ("nebulaId")
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
    "fullContext" TEXT,
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
CREATE TABLE "Nebula" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "gitUrl" TEXT NOT NULL,
    "branch" TEXT NOT NULL DEFAULT 'main',
    "path" TEXT NOT NULL DEFAULT 'novas',
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncAt" TIMESTAMP(3),
    "syncStatus" TEXT NOT NULL DEFAULT 'pending',
    "syncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Nebula_pkey" PRIMARY KEY ("id")
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

-- CreateTable
CREATE TABLE "Investigation" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "InvestigationStatus" NOT NULL DEFAULT 'open',
    "severity" INTEGER NOT NULL,
    "tlp" "TLP" NOT NULL DEFAULT 'amber',
    "pap" INTEGER NOT NULL DEFAULT 2,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "resolutionType" "ResolutionType",
    "assignedTo" TEXT,
    "createdBy" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dueAt" TIMESTAMP(3),
    "mitreAttackIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "externalId" TEXT,
    "externalSystem" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "syncVersion" INTEGER NOT NULL DEFAULT 0,
    "syncSource" TEXT,
    "timeToDetect" INTEGER,
    "timeToRespond" INTEGER,
    "timeToResolve" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Investigation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvestigationNote" (
    "id" TEXT NOT NULL,
    "investigationId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "authorType" TEXT NOT NULL,
    "isDraft" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),
    "searchVector" tsvector,

    CONSTRAINT "InvestigationNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvestigationObservable" (
    "id" TEXT NOT NULL,
    "investigationId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "displayValue" TEXT NOT NULL,
    "category" "ObservableCategory" NOT NULL,
    "role" "ObservableRole" NOT NULL DEFAULT 'ioc',
    "verdict" "ObservableVerdict" NOT NULL DEFAULT 'unknown',
    "verdictBy" TEXT,
    "verdictAt" TIMESTAMP(3),
    "confidence" INTEGER NOT NULL DEFAULT 0,
    "severity" INTEGER NOT NULL DEFAULT 0,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL,
    "context" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "threatIntelMatch" JSONB,
    "externalId" TEXT,
    "lastSyncedAt" TIMESTAMP(3),

    CONSTRAINT "InvestigationObservable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvestigationTimeline" (
    "id" TEXT NOT NULL,
    "investigationId" TEXT NOT NULL,
    "eventTime" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "source" TEXT NOT NULL,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB,

    CONSTRAINT "InvestigationTimeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvestigationAudit" (
    "id" TEXT NOT NULL,
    "investigationId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvestigationAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskCheckpoint" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "toolName" TEXT NOT NULL,
    "argsHash" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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
    "reviewedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ToolExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvalSuite" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "agentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvalSuite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvalCase" (
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
CREATE TABLE "EvalRun" (
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
CREATE TABLE "EvalCaseResult" (
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

-- CreateTable
CREATE TABLE "DriftReport" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'clean',
    "driftCount" INTEGER NOT NULL DEFAULT 0,
    "findings" TEXT NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriftReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "lastTaskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookTrigger" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'custom',
    "taskTitle" TEXT NOT NULL,
    "taskDesc" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastFiredAt" TIMESTAMP(3),
    "fireCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookTrigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "triggerId" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "agentId" TEXT,
    "taskId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "errorMessage" TEXT,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationChannel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "webhookUrl" TEXT NOT NULL,
    "events" TEXT NOT NULL DEFAULT '["task_completed","task_failed"]',
    "agentFilter" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationChannel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Memory_conversationId_key_key" ON "Memory"("conversationId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_name_key" ON "Agent"("name");

-- CreateIndex
CREATE INDEX "Agent_createdBy_idx" ON "Agent"("createdBy");

-- CreateIndex
CREATE INDEX "AgentTokenUsage_agentId_recordedAt_idx" ON "AgentTokenUsage"("agentId", "recordedAt");

-- CreateIndex
CREATE INDEX "AgentTokenUsage_taskId_idx" ON "AgentTokenUsage"("taskId");

-- CreateIndex
CREATE INDEX "AgentTokenUsage_modelId_idx" ON "AgentTokenUsage"("modelId");

-- CreateIndex
CREATE UNIQUE INDEX "Environment_name_key" ON "Environment"("name");

-- CreateIndex
CREATE INDEX "Environment_createdBy_idx" ON "Environment"("createdBy");

-- CreateIndex
CREATE UNIQUE INDEX "GitOpsPR_environmentId_prNumber_key" ON "GitOpsPR"("environmentId", "prNumber");

-- CreateIndex
CREATE UNIQUE INDEX "McpTool_environmentId_name_key" ON "McpTool"("environmentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "AgentEnvironment_agentId_environmentId_key" ON "AgentEnvironment"("agentId", "environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "EnvironmentJoinToken_token_key" ON "EnvironmentJoinToken"("token");

-- CreateIndex
CREATE INDEX "Task_status_assignedAgent_wave_priority_createdAt_idx" ON "Task"("status", "assignedAgent", "wave", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "Task_createdBy_idx" ON "Task"("createdBy");

-- CreateIndex
CREATE UNIQUE INDEX "FederatedDispatch_taskId_key" ON "FederatedDispatch"("taskId");

-- CreateIndex
CREATE INDEX "FederatedDispatch_targetEnvId_idx" ON "FederatedDispatch"("targetEnvId");

-- CreateIndex
CREATE INDEX "FederatedDispatch_status_idx" ON "FederatedDispatch"("status");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_ipAddress_idx" ON "AuditLog"("ipAddress");

-- CreateIndex
CREATE INDEX "Note_createdBy_idx" ON "Note"("createdBy");

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
CREATE UNIQUE INDEX "chat_rooms_featureId_key" ON "chat_rooms"("featureId");

-- CreateIndex
CREATE INDEX "room_goals_roomId_status_idx" ON "room_goals"("roomId", "status");

-- CreateIndex
CREATE INDEX "room_goals_roomId_createdAt_idx" ON "room_goals"("roomId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "chat_room_members_roomId_agentId_key" ON "chat_room_members"("roomId", "agentId");

-- CreateIndex
CREATE UNIQUE INDEX "chat_room_members_roomId_userId_key" ON "chat_room_members"("roomId", "userId");

-- CreateIndex
CREATE INDEX "chat_messages_roomId_createdAt_idx" ON "chat_messages"("roomId", "createdAt");

-- CreateIndex
CREATE INDEX "chat_messages_roomId_taskId_createdAt_idx" ON "chat_messages"("roomId", "taskId", "createdAt");

-- CreateIndex
CREATE INDEX "chat_messages_incidentId_idx" ON "chat_messages"("incidentId");

-- CreateIndex
CREATE INDEX "managed_secrets_environmentId_idx" ON "managed_secrets"("environmentId");

-- CreateIndex
CREATE INDEX "SecurityEvent_environmentId_createdAt_idx" ON "SecurityEvent"("environmentId", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_environmentId_type_acknowledged_idx" ON "SecurityEvent"("environmentId", "type", "acknowledged");

-- CreateIndex
CREATE INDEX "SecurityEvent_incidentId_idx" ON "SecurityEvent"("incidentId");

-- CreateIndex
CREATE INDEX "SecurityEvent_dedupKey_idx" ON "SecurityEvent"("dedupKey");

-- CreateIndex
CREATE INDEX "SecurityEvent_type_scannedAt_idx" ON "SecurityEvent"("type", "scannedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SecurityConfig_environmentId_key_key" ON "SecurityConfig"("environmentId", "key");

-- CreateIndex
CREATE INDEX "Incident_environmentId_status_idx" ON "Incident"("environmentId", "status");

-- CreateIndex
CREATE INDEX "Incident_environmentId_severity_idx" ON "Incident"("environmentId", "severity");

-- CreateIndex
CREATE INDEX "Incident_investigationId_idx" ON "Incident"("investigationId");

-- CreateIndex
CREATE INDEX "ContainmentRequest_incidentId_idx" ON "ContainmentRequest"("incidentId");

-- CreateIndex
CREATE INDEX "ContainmentRequest_status_idx" ON "ContainmentRequest"("status");

-- CreateIndex
CREATE INDEX "ActionAudit_incidentId_idx" ON "ActionAudit"("incidentId");

-- CreateIndex
CREATE INDEX "ActionAudit_status_idx" ON "ActionAudit"("status");

-- CreateIndex
CREATE INDEX "ActionAudit_tier_idx" ON "ActionAudit"("tier");

-- CreateIndex
CREATE UNIQUE INDEX "ActionPolicy_actionType_key" ON "ActionPolicy"("actionType");

-- CreateIndex
CREATE INDEX "ActionPolicy_actionType_idx" ON "ActionPolicy"("actionType");

-- CreateIndex
CREATE INDEX "ActionPolicy_environmentId_idx" ON "ActionPolicy"("environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "CorrelationRule_name_key" ON "CorrelationRule"("name");

-- CreateIndex
CREATE INDEX "CorrelationRule_enabled_idx" ON "CorrelationRule"("enabled");

-- CreateIndex
CREATE INDEX "CorrelationRule_environmentId_idx" ON "CorrelationRule"("environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "SourceHealth_source_key" ON "SourceHealth"("source");

-- CreateIndex
CREATE INDEX "SourceHealth_source_idx" ON "SourceHealth"("source");

-- CreateIndex
CREATE INDEX "SourceHealth_environmentId_idx" ON "SourceHealth"("environmentId");

-- CreateIndex
CREATE INDEX "EnvironmentSourceHealth_source_idx" ON "EnvironmentSourceHealth"("source");

-- CreateIndex
CREATE INDEX "EnvironmentSourceHealth_environmentId_idx" ON "EnvironmentSourceHealth"("environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "EnvironmentSourceHealth_environmentId_source_key" ON "EnvironmentSourceHealth"("environmentId", "source");

-- CreateIndex
CREATE INDEX "VulnerabilityFinding_environmentId_idx" ON "VulnerabilityFinding"("environmentId");

-- CreateIndex
CREATE INDEX "VulnerabilityFinding_cveId_idx" ON "VulnerabilityFinding"("cveId");

-- CreateIndex
CREATE INDEX "VulnerabilityFinding_isKev_idx" ON "VulnerabilityFinding"("isKev");

-- CreateIndex
CREATE INDEX "VulnerabilityFinding_status_idx" ON "VulnerabilityFinding"("status");

-- CreateIndex
CREATE INDEX "VulnerabilityFinding_severity_idx" ON "VulnerabilityFinding"("severity");

-- CreateIndex
CREATE UNIQUE INDEX "VulnerabilityFinding_environmentId_target_cveId_packageName_key" ON "VulnerabilityFinding"("environmentId", "target", "cveId", "packageName");

-- CreateIndex
CREATE INDEX "VulnerabilityScan_environmentId_startedAt_idx" ON "VulnerabilityScan"("environmentId", "startedAt");

-- CreateIndex
CREATE INDEX "VulnerabilityScan_status_idx" ON "VulnerabilityScan"("status");

-- CreateIndex
CREATE INDEX "Suppression_expiresAt_idx" ON "Suppression"("expiresAt");

-- CreateIndex
CREATE INDEX "Suppression_environmentId_idx" ON "Suppression"("environmentId");

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
CREATE UNIQUE INDEX "room_knowledge_roomId_title_key" ON "room_knowledge"("roomId", "title");

-- CreateIndex
CREATE INDEX "agent_knowledge_agentId_idx" ON "agent_knowledge"("agentId");

-- CreateIndex
CREATE INDEX "agent_knowledge_tags_idx" ON "agent_knowledge"("tags");

-- CreateIndex
CREATE UNIQUE INDEX "agent_knowledge_agentId_title_key" ON "agent_knowledge"("agentId", "title");

-- CreateIndex
CREATE UNIQUE INDEX "NovaDefinition_name_key" ON "NovaDefinition"("name");

-- CreateIndex
CREATE INDEX "NovaDefinition_category_idx" ON "NovaDefinition"("category");

-- CreateIndex
CREATE INDEX "NebulaInstance_environmentId_category_isInstalled_idx" ON "NebulaInstance"("environmentId", "category", "isInstalled");

-- CreateIndex
CREATE INDEX "NebulaInstance_createdByAgentId_idx" ON "NebulaInstance"("createdByAgentId");

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
CREATE UNIQUE INDEX "Nebula_name_key" ON "Nebula"("name");

-- CreateIndex
CREATE UNIQUE INDEX "AgentScore_targetType_targetId_key" ON "AgentScore"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "Investigation_status_idx" ON "Investigation"("status");

-- CreateIndex
CREATE INDEX "Investigation_createdAt_idx" ON "Investigation"("createdAt");

-- CreateIndex
CREATE INDEX "Investigation_externalId_idx" ON "Investigation"("externalId");

-- CreateIndex
CREATE INDEX "InvestigationNote_investigationId_createdAt_idx" ON "InvestigationNote"("investigationId", "createdAt");

-- CreateIndex
CREATE INDEX "InvestigationNote_investigationId_authorType_idx" ON "InvestigationNote"("investigationId", "authorType");

-- CreateIndex
CREATE INDEX "InvestigationObservable_value_idx" ON "InvestigationObservable"("value");

-- CreateIndex
CREATE INDEX "InvestigationObservable_category_idx" ON "InvestigationObservable"("category");

-- CreateIndex
CREATE INDEX "InvestigationObservable_verdict_idx" ON "InvestigationObservable"("verdict");

-- CreateIndex
CREATE UNIQUE INDEX "InvestigationObservable_investigationId_value_category_key" ON "InvestigationObservable"("investigationId", "value", "category");

-- CreateIndex
CREATE INDEX "InvestigationTimeline_investigationId_eventTime_idx" ON "InvestigationTimeline"("investigationId", "eventTime");

-- CreateIndex
CREATE INDEX "InvestigationTimeline_investigationId_eventType_idx" ON "InvestigationTimeline"("investigationId", "eventType");

-- CreateIndex
CREATE INDEX "InvestigationAudit_investigationId_timestamp_idx" ON "InvestigationAudit"("investigationId", "timestamp");

-- CreateIndex
CREATE INDEX "TaskCheckpoint_taskId_idx" ON "TaskCheckpoint"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskCheckpoint_taskId_stepIndex_key" ON "TaskCheckpoint"("taskId", "stepIndex");

-- CreateIndex
CREATE UNIQUE INDEX "ToolExecution_executionId_key" ON "ToolExecution"("executionId");

-- CreateIndex
CREATE INDEX "ToolExecution_actorId_createdAt_idx" ON "ToolExecution"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "ToolExecution_status_createdAt_idx" ON "ToolExecution"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ToolExecution_tool_createdAt_idx" ON "ToolExecution"("tool", "createdAt");

-- CreateIndex
CREATE INDEX "ToolExecution_expiresAt_idx" ON "ToolExecution"("expiresAt");

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

-- CreateIndex
CREATE INDEX "DriftReport_environmentId_scannedAt_idx" ON "DriftReport"("environmentId", "scannedAt");

-- CreateIndex
CREATE INDEX "ScheduledTask_agentId_idx" ON "ScheduledTask"("agentId");

-- CreateIndex
CREATE INDEX "ScheduledTask_nextRunAt_enabled_idx" ON "ScheduledTask"("nextRunAt", "enabled");

-- CreateIndex
CREATE INDEX "WebhookTrigger_agentId_idx" ON "WebhookTrigger"("agentId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_receivedAt_idx" ON "WebhookDelivery"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_triggerId_deliveryId_key" ON "WebhookDelivery"("triggerId", "deliveryId");

-- CreateIndex
CREATE INDEX "JobRun_source_startedAt_idx" ON "JobRun"("source", "startedAt");

-- CreateIndex
CREATE INDEX "JobRun_sourceId_startedAt_idx" ON "JobRun"("sourceId", "startedAt");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaudeInvocation" ADD CONSTRAINT "ClaudeInvocation_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Memory" ADD CONSTRAINT "Memory_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_novaId_fkey" FOREIGN KEY ("novaId") REFERENCES "nova"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTokenUsage" ADD CONSTRAINT "AgentTokenUsage_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Environment" ADD CONSTRAINT "Environment_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FederatedDispatch" ADD CONSTRAINT "FederatedDispatch_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskEvent" ADD CONSTRAINT "TaskEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
ALTER TABLE "chat_rooms" ADD CONSTRAINT "chat_rooms_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "Feature"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_rooms" ADD CONSTRAINT "chat_rooms_epicId_fkey" FOREIGN KEY ("epicId") REFERENCES "Epic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_goals" ADD CONSTRAINT "room_goals_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "chat_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_secrets" ADD CONSTRAINT "managed_secrets_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_secrets" ADD CONSTRAINT "managed_secrets_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityConfig" ADD CONSTRAINT "SecurityConfig_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContainmentRequest" ADD CONSTRAINT "ContainmentRequest_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionAudit" ADD CONSTRAINT "ActionAudit_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionAudit" ADD CONSTRAINT "ActionAudit_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionAudit" ADD CONSTRAINT "ActionAudit_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "ActionPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionPolicy" ADD CONSTRAINT "ActionPolicy_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CorrelationRule" ADD CONSTRAINT "CorrelationRule_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceHealth" ADD CONSTRAINT "SourceHealth_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvironmentSourceHealth" ADD CONSTRAINT "EnvironmentSourceHealth_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VulnerabilityFinding" ADD CONSTRAINT "VulnerabilityFinding_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VulnerabilityFinding" ADD CONSTRAINT "VulnerabilityFinding_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VulnerabilityFinding" ADD CONSTRAINT "VulnerabilityFinding_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "VulnerabilityScan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VulnerabilityScan" ADD CONSTRAINT "VulnerabilityScan_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Suppression" ADD CONSTRAINT "Suppression_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
ALTER TABLE "NebulaInstance" ADD CONSTRAINT "NebulaInstance_createdByAgentId_fkey" FOREIGN KEY ("createdByAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nebula_embeddings" ADD CONSTRAINT "nebula_embeddings_nebulaId_fkey" FOREIGN KEY ("nebulaId") REFERENCES "NebulaInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HookExecutionLog" ADD CONSTRAINT "HookExecutionLog_nebulaId_fkey" FOREIGN KEY ("nebulaId") REFERENCES "NebulaInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillExecutionLog" ADD CONSTRAINT "SkillExecutionLog_nebulaId_fkey" FOREIGN KEY ("nebulaId") REFERENCES "NebulaInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Eval" ADD CONSTRAINT "Eval_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentScore" ADD CONSTRAINT "AgentScore_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestigationNote" ADD CONSTRAINT "InvestigationNote_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestigationObservable" ADD CONSTRAINT "InvestigationObservable_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestigationTimeline" ADD CONSTRAINT "InvestigationTimeline_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestigationAudit" ADD CONSTRAINT "InvestigationAudit_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolExecution" ADD CONSTRAINT "ToolExecution_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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

-- AddForeignKey
ALTER TABLE "DriftReport" ADD CONSTRAINT "DriftReport_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledTask" ADD CONSTRAINT "ScheduledTask_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookTrigger" ADD CONSTRAINT "WebhookTrigger_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Raw-SQL objects not representable in schema.prisma ─────────────────────

-- 7_note_embeddings_hnsw_index
CREATE INDEX IF NOT EXISTS note_embeddings_embedding_hnsw_idx
  ON note_embeddings
  USING hnsw (embedding vector_cosine_ops);

-- 20260714_nebula_embeddings
CREATE INDEX IF NOT EXISTS nebula_embeddings_embedding_hnsw_idx
  ON nebula_embeddings
  USING hnsw (embedding vector_cosine_ops);

-- 10_soc_case_management
CREATE INDEX IF NOT EXISTS "InvestigationNote_searchVector_idx" ON "InvestigationNote" USING gin("searchVector");

-- 20260808_note_search_vector
CREATE INDEX IF NOT EXISTS "Note_searchVector_idx" ON "Note" USING gin("searchVector");

-- 13_siem_notify_triggers
-- Migration: LISTEN/NOTIFY triggers for SSE real-time stream
--
-- Creates a trigger function and triggers on SecurityEvent, Incident,
-- and ActionAudit tables. Each trigger fires pg_notify on its OWN
-- channel only (events / incidents / approvals) — driven by TG_ARGV[0]
-- so that one shared function can serve all three tables without
-- cross-broadcasting every change to every channel.
--
-- The SSE stream endpoint (stream/route.ts) listens on the channel
-- it cares about and receives ID-only frames.

-- ── Trigger function ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION orion_security_notify() RETURNS TRIGGER AS $notify$
DECLARE
  channel_suffix TEXT;
  channel_name TEXT;
BEGIN
  -- TG_ARGV[0] is supplied per trigger: 'events' | 'incidents' | 'approvals'
  channel_suffix := TG_ARGV[0];
  channel_name := 'orion_security_' || channel_suffix;

  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify(channel_name, OLD.id::text || ':deleted');
  ELSE
    PERFORM pg_notify(channel_name, NEW.id::text || ':created');
  END IF;

  RETURN NULL; -- AFTER trigger: return value is ignored
END;
$notify$ LANGUAGE plpgsql;

-- ── SecurityEvent triggers ────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS security_event_notify ON "SecurityEvent";
CREATE TRIGGER security_event_notify
  AFTER INSERT OR UPDATE OR DELETE ON "SecurityEvent"
  FOR EACH ROW EXECUTE FUNCTION orion_security_notify('events');

-- ── Incident triggers ─────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS incident_notify ON "Incident";
CREATE TRIGGER incident_notify
  AFTER INSERT OR UPDATE OR DELETE ON "Incident"
  FOR EACH ROW EXECUTE FUNCTION orion_security_notify('incidents');

-- ── ActionAudit triggers ──────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS action_audit_notify ON "ActionAudit";
CREATE TRIGGER action_audit_notify
  AFTER INSERT OR UPDATE OR DELETE ON "ActionAudit"
  FOR EACH ROW EXECUTE FUNCTION orion_security_notify('approvals');

-- 20260615_source_health_notify
-- Migration: LISTEN/NOTIFY triggers for SourceHealth + EnvironmentSourceHealth
--
-- Adds NOTIFY triggers on both source-health tables so the SSE stream's
-- 'sources' channel wakes instantly when ingestion health changes. Reuses
-- the shared orion_security_notify() function (TG_ARGV[0]='sources') created
-- in 13_siem_notify_triggers.
--
-- DROP TRIGGER IF EXISTS guards make this migration idempotent (safe to
-- re-run / re-apply against an existing database).

DROP TRIGGER IF EXISTS source_health_notify ON "SourceHealth";
CREATE TRIGGER source_health_notify
  AFTER INSERT OR UPDATE ON "SourceHealth"
  FOR EACH ROW EXECUTE FUNCTION orion_security_notify('sources');

DROP TRIGGER IF EXISTS env_source_health_notify ON "EnvironmentSourceHealth";
CREATE TRIGGER env_source_health_notify
  AFTER INSERT OR UPDATE ON "EnvironmentSourceHealth"
  FOR EACH ROW EXECUTE FUNCTION orion_security_notify('sources');
