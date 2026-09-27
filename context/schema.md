# Prisma Schema — Models Reference

> **Generated** from `apps/web/prisma/schema.prisma` by `node context/gen-schema.mjs` — do not edit by hand.
> Migration workflow: `apps/web/prisma/MIGRATIONS.md`.
> Referenced by: [[web-call-graph]], [[api-routes]]

97 models, 8 enums.

## Index

[Conversation](#conversation) · [Message](#message) · [ClaudeInvocation](#claudeinvocation) · [Memory](#memory) · [Agent](#agent) · [AgentTokenUsage](#agenttokenusage) · [Environment](#environment) · [EnvironmentGitCredential](#environmentgitcredential) · [GitOpsPR](#gitopspr) · [McpTool](#mcptool) · [AgentEnvironment](#agentenvironment) · [EnvironmentJoinToken](#environmentjointoken) · [AgentMessage](#agentmessage) · [Epic](#epic) · [Feature](#feature) · [Task](#task) · [FederatedDispatch](#federateddispatch) · [TaskEvent](#taskevent) · [AuditLog](#auditlog) · [SavedView](#savedview) · [SystemSetting](#systemsetting) · [SystemPrompt](#systemprompt) · [Note](#note) · [NoteEmbedding](#noteembedding) · [SemanticConnection](#semanticconnection) · [User](#user) · [ApiKey](#apikey) · [Session](#session) · [VerificationToken](#verificationtoken) · [Bug](#bug) · [ExternalModel](#externalmodel) · [OIDCProvider](#oidcprovider) · [ToolGroup](#toolgroup) · [ToolGroupTool](#toolgrouptool) · [AgentGroup](#agentgroup) · [AgentGroupMember](#agentgroupmember) · [AgentGroupToolAccess](#agentgrouptoolaccess) · [ToolAgentRestriction](#toolagentrestriction) · [EnvironmentUserTier](#environmentusertier) · [ToolApprovalRequest](#toolapprovalrequest) · [ToolExecutionGrant](#toolexecutiongrant) · [Domain](#domain) · [DnsRecord](#dnsrecord) · [IngressPoint](#ingresspoint) · [IngressRoute](#ingressroute) · [BackgroundJob](#backgroundjob) · [IngressMiddleware](#ingressmiddleware) · [Nova](#nova) · [NovaDeployment](#novadeployment) · [NovaRevision](#novarevision) · [ChatRoom](#chatroom) · [RoomGoal](#roomgoal) · [ChatRoomMember](#chatroommember) · [ChatMessage](#chatmessage) · [ManagedSecret](#managedsecret) · [SecurityEvent](#securityevent) · [SecurityConfig](#securityconfig) · [Incident](#incident) · [ContainmentRequest](#containmentrequest) · [ActionAudit](#actionaudit) · [ActionPolicy](#actionpolicy) · [CorrelationRule](#correlationrule) · [SourceHealth](#sourcehealth) · [EnvironmentSourceHealth](#environmentsourcehealth) · [VulnerabilityFinding](#vulnerabilityfinding) · [VulnerabilityScan](#vulnerabilityscan) · [Suppression](#suppression) · [AgentProfile](#agentprofile) · [RoomKnowledge](#roomknowledge) · [AgentKnowledge](#agentknowledge) · [NovaDefinition](#novadefinition) · [NebulaInstance](#nebulainstance) · [NebulaEmbedding](#nebulaembedding) · [HookExecutionLog](#hookexecutionlog) · [SkillExecutionLog](#skillexecutionlog) · [AgentTrace](#agenttrace) · [Eval](#eval) · [Ruleset](#ruleset) · [Nebula](#nebula) · [AgentScore](#agentscore) · [Investigation](#investigation) · [InvestigationNote](#investigationnote) · [InvestigationObservable](#investigationobservable) · [InvestigationTimeline](#investigationtimeline) · [InvestigationAudit](#investigationaudit) · [TaskCheckpoint](#taskcheckpoint) · [ToolExecution](#toolexecution) · [EvalSuite](#evalsuite) · [EvalCase](#evalcase) · [EvalRun](#evalrun) · [EvalCaseResult](#evalcaseresult) · [DriftReport](#driftreport) · [ScheduledTask](#scheduledtask) · [WebhookTrigger](#webhooktrigger) · [WebhookDelivery](#webhookdelivery) · [JobRun](#jobrun) · [NotificationChannel](#notificationchannel)

## Models

### Conversation

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| title | String? |  |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |
| archivedAt | DateTime? |  |  |
| metadata | Json? |  |  |
| messages | → Message[] |  |  |
| invocations | → ClaudeInvocation[] |  |  |
| memories | → Memory[] |  | Persistent key-value facts for this conversation |

### Message

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| conversationId | String |  |  |
| conversation | → Conversation | `@relation(fields: [conversationId], references: [id], onDelete: Cascade)` |  |
| role | String |  | user \| assistant \| tool_result \| system |
| content | String | `@db.Text` |  |
| model | String? |  |  |
| inputTokens | Int? |  |  |
| outputTokens | Int? |  |  |
| createdAt | DateTime | `@default(now())` |  |
| metadata | Json? |  |  |

`@@index([conversationId, createdAt])`

### ClaudeInvocation

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| conversationId | String |  |  |
| conversation | → Conversation | `@relation(fields: [conversationId], references: [id], onDelete: Cascade)` |  |
| prompt | String | `@db.Text` |  |
| toolsUsed | Json |  |  |
| tokensUsed | Int? |  |  |
| durationMs | Int |  |  |
| success | Boolean | `@default(true)` |  |
| createdAt | DateTime | `@default(now())` |  |

`@@index([conversationId])` · `@@index([createdAt])`

### Memory

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| conversationId | String |  |  |
| conversation | → Conversation | `@relation(fields: [conversationId], references: [id], onDelete: Cascade)` |  |
| key | String |  | e.g., "user_preference_editor", "project_main_language" |
| value | String | `@db.Text` |  |
| context | String? | `@db.Text` | When/why this was stored (optional) |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |

`@@unique([conversationId, key])`

### Agent

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| name | String | `@unique` |  |
| type | String | `@default("human")` | claude \| human \| custom |
| role | String? |  |  |
| description | String? | `@db.Text` |  |
| status | String | `@default("offline")` |  |
| lastSeen | DateTime? |  |  |
| metadata | Json? |  | { systemPrompt?: string } |
| novaId | String? |  | Reference to the Nova definition this agent was imported from |
| nova | → Nova? | `@relation(fields: [novaId], references: [id], onDelete: SetNull)` |  |
| tokenBudgetDay | Int? |  | max tokens per day (input+output combined), null = unlimited |
| tokenBudgetMonth | Int? |  | max tokens per calendar month, null = unlimited |
| createdBy | String? |  |  |
| creator | → User? | `@relation("AgentCreator", fields: [createdBy], references: [id], onDelete: SetNull)` |  |
| messages | → AgentMessage[] |  |  |
| tasks | → Task[] | `@relation("AssignedTasks")` |  |
| environments | → AgentEnvironment[] |  |  |
| agentGroups | → AgentGroupMember[] |  |  |
| toolRestrictions | → ToolAgentRestriction[] |  |  |
| novaDeployments | → NovaDeployment[] |  |  |
| chatRoomMembers | → ChatRoomMember[] |  |  |
| chatMessages | → ChatMessage[] |  |  |
| profiles | → AgentProfile[] |  |  |
| knowledge | → AgentKnowledge[] |  |  |
| evalSuites | → EvalSuite[] | `@relation("EvalSuiteAgent")` |  |
| evalRuns | → EvalRun[] | `@relation("EvalRunAgent")` |  |
| tokenUsage | → AgentTokenUsage[] |  |  |
| webhookTriggers | → WebhookTrigger[] | `@relation("WebhookTriggerAgent")` |  |
| scheduledTasks | → ScheduledTask[] | `@relation("ScheduledTaskAgent")` |  |
| mcpToken | String? |  | AES-GCM encrypted per-agent MCP token (no @unique — random IV means ciphertext differs each time) |
| savedSkills | → NebulaInstance[] |  |  |

`@@index([createdBy])`

### AgentTokenUsage

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| agentId | String |  |  |
| agent | → Agent | `@relation(fields: [agentId], references: [id], onDelete: Cascade)` |  |
| taskId | String? |  |  |
| modelId | String? |  | e.g. "claude-sonnet-4-6", "gpt-4o", "llama3" — null for legacy rows |
| inputTokens | Int | `@default(0)` |  |
| outputTokens | Int | `@default(0)` |  |
| recordedAt | DateTime | `@default(now())` |  |

`@@index([agentId, recordedAt])` · `@@index([taskId])` · `@@index([modelId])` · `@@index([recordedAt])`

### Environment

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| name | String | `@unique` |  |
| type | String | `@default("cluster")` | "cluster" \| "docker" |
| description | String? | `@db.Text` |  |
| gatewayUrl | String? |  |  |
| gatewayToken | String? |  | hashed token for gateway auth |
| gatewayVersion | String? |  | version reported by the gateway on heartbeat |
| status | String | `@default("disconnected")` | "connected" \| "disconnected" \| "error" |
| lastSeen | DateTime? |  |  |
| metadata | Json? |  |  |
| monitoringConfig | Json? |  | { stack: 'none' \| 'basic' \| 'full' } |
| createdBy | String? |  |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |
| gitProvider | String? |  | "gitea-bundled" \| "gitea" \| "github" \| "gitlab" (inherits global if null) |
| gitOwner | String? |  | org/user that owns this env's repo |
| gitRepo | String? |  | repo name for this environment |
| repoPath | String? |  | ArgoCD-watched sub-directory in the repo, e.g. "deployments" |
| vaultPathPrefix | String? |  | Vault KV prefix for this env's secrets, e.g. "Talos Cluster" → secret/Talos Cluster/<service> |
| argoCdUrl | String? |  | ArgoCD URL (K8s clusters only) |
| policyConfig | Json? |  | PolicyConfig: { reviewAll?, overrides? } |
| kubeconfig | String? | `@db.Text` | base64 kubeconfig (K8s clusters only) |
| federationRole | String? |  | 'hub' \| 'spoke' \| null (standalone) |
| federationToken | String? |  | shared secret for hub↔spoke auth |
| spokeUrl | String? |  | for spokes: their own base URL (so hub can reach them) |
| hubUrl | String? |  | for spokes: URL of their hub |
| tools | → McpTool[] |  |  |
| agents | → AgentEnvironment[] |  |  |
| joinTokens | → EnvironmentJoinToken[] |  |  |
| gitOpsPRs | → GitOpsPR[] |  |  |
| toolGroups | → ToolGroup[] |  |  |
| userTiers | → EnvironmentUserTier[] |  |  |
| ingressPoints | → IngressPoint[] |  |  |
| coreDnsDomains | → Domain[] | `@relation("DomainCoreDns")` |  |
| novaDeployments | → NovaDeployment[] |  |  |
| managedSecrets | → ManagedSecret[] |  |  |
| securityEvents | → SecurityEvent[] |  |  |
| securityConfigs | → SecurityConfig[] |  |  |
| nebulaInstances | → NebulaInstance[] |  |  |
| evals | → Eval[] |  |  |
| agentScores | → AgentScore[] |  |  |
| incidents | → Incident[] |  |  |
| actionAudits | → ActionAudit[] |  |  |
| actionPolicies | → ActionPolicy[] |  |  |
| correlationRules | → CorrelationRule[] |  |  |
| sourceHealths | → SourceHealth[] |  |  |
| environmentSourceHealths | → EnvironmentSourceHealth[] |  |  |
| vulnerabilityFindings | → VulnerabilityFinding[] |  |  |
| vulnerabilityScans | → VulnerabilityScan[] |  |  |
| suppressions | → Suppression[] |  |  |
| toolExecutions | → ToolExecution[] |  |  |
| driftReports | → DriftReport[] |  |  |
| gitCredential | → EnvironmentGitCredential? |  |  |
| creator | → User? | `@relation("EnvironmentCreator", fields: [createdBy], references: [id], onDelete: SetNull)` |  |

`@@index([createdBy])`

### EnvironmentGitCredential

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| environmentId | String | `@unique` |  |
| provider | String |  | "gitea" \| "github" \| "gitlab" |
| kind | String |  | "https-token" \| "ssh-key" |
| username | String |  |  |
| secret | String | `@db.Text` | encrypted (enc:v1:) token or private key |
| repoUrl | String |  | exact URL ArgoCD clones (matches the Application repoURL) |
| providerRef | Json |  | what to revoke at the provider |
| createdAt | DateTime | `@default(now())` |  |
| environment | → Environment | `@relation(fields: [environmentId], references: [id], onDelete: Cascade)` |  |

### GitOpsPR

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| environmentId | String |  |  |
| environment | → Environment | `@relation(fields: [environmentId], references: [id], onDelete: Cascade)` |  |
| prNumber | Int |  |  |
| title | String |  |  |
| operation | String |  | OperationType value |
| decision | String |  | "auto" \| "review" |
| status | String | `@default("open")` | "open" \| "merged" \| "closed" |
| prUrl | String |  |  |
| reasoning | String? | `@db.Text` |  |
| branch | String |  |  |
| mergedAt | DateTime? |  |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |

`@@unique([environmentId, prNumber])`

### McpTool

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| environmentId | String |  |  |
| environment | → Environment | `@relation(fields: [environmentId], references: [id], onDelete: Cascade)` |  |
| name | String |  |  |
| description | String | `@db.Text` |  |
| inputSchema | Json |  | JSON Schema { type: "object", properties: {...}, required: [...] } |
| execType | String | `@default("builtin")` | "builtin" \| "shell" \| "http" |
| execConfig | Json? |  | builtin: { fn: "kubectl_get_pods" } \| shell: { command: "..." } \| http: { url: "..." } |
| enabled | Boolean | `@default(true)` |  |
| builtIn | Boolean | `@default(false)` | true = shipped with gateway binary |
| status | String | `@default("active")` | "active" \| "pending" \| "rejected" |
| proposedBy | String? |  | conversationId that triggered the proposal |
| proposedAt | DateTime? |  |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |
| toolGroups | → ToolGroupTool[] |  |  |
| agentRestrictions | → ToolAgentRestriction[] |  |  |

`@@unique([environmentId, name])`

### AgentEnvironment

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| agentId | String |  |  |
| agent | → Agent | `@relation(fields: [agentId], references: [id], onDelete: Cascade)` |  |
| environmentId | String |  |  |
| environment | → Environment | `@relation(fields: [environmentId], references: [id], onDelete: Cascade)` |  |
| createdAt | DateTime | `@default(now())` |  |

`@@unique([agentId, environmentId])`

### EnvironmentJoinToken

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| token | String | `@unique` | mcg_<random> — one-time use |
| environmentId | String |  |  |
| environment | → Environment | `@relation(fields: [environmentId], references: [id], onDelete: Cascade)` |  |
| usedAt | DateTime? |  |  |
| expiresAt | DateTime |  |  |
| createdAt | DateTime | `@default(now())` |  |
| fingerprint | String? |  | SHA-256 of the machineId presented at first join — verified on re-join |

### AgentMessage

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| agentId | String? |  |  |
| agent | → Agent? | `@relation(fields: [agentId], references: [id], onDelete: SetNull)` |  |
| channel | String | `@default("general")` |  |
| content | String | `@db.Text` |  |
| messageType | String | `@default("text")` |  |
| threadId | String? |  |  |
| createdAt | DateTime | `@default(now())` |  |
| metadata | Json? |  |  |

`@@index([channel, createdAt])` · `@@index([agentId])` · `@@index([createdAt])`

### Epic

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| title | String |  |  |
| description | String? | `@db.Text` |  |
| plan | String? | `@db.Text` |  |
| status | String | `@default("active")` |  |
| createdBy | String | `@default("admin")` |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |
| planApprovedBy | String? |  |  |
| planApprovedAt | DateTime? |  |  |
| features | → Feature[] |  |  |
| chatRooms | → ChatRoom[] | `@relation("EpicChatRooms")` |  |

### Feature

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| epicId | String |  |  |
| epic | → Epic | `@relation(fields: [epicId], references: [id], onDelete: Cascade)` |  |
| title | String |  |  |
| description | String? | `@db.Text` |  |
| plan | String? | `@db.Text` |  |
| status | String | `@default("active")` |  |
| createdBy | String | `@default("admin")` |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |
| planApprovedBy | String? |  |  |
| planApprovedAt | DateTime? |  |  |
| tasks | → Task[] |  |  |
| chatRooms | → ChatRoom[] | `@relation("FeatureChatRooms")` |  |

### Task

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| title | String |  |  |
| description | String? | `@db.Text` |  |
| plan | String? | `@db.Text` |  |
| status | String | `@default("pending")` |  |
| priority | String | `@default("medium")` |  |
| featureId | String? |  |  |
| feature | → Feature? | `@relation(fields: [featureId], references: [id], onDelete: Cascade)` |  |
| assignedAgent | String? |  |  |
| agent | → Agent? | `@relation("AssignedTasks", fields: [assignedAgent], references: [id], onDelete: SetNull)` |  |
| assignedUserId | String? |  |  |
| assignedUser | → User? | `@relation("AssignedUserTasks", fields: [assignedUserId], references: [id], onDelete: SetNull)` |  |
| createdBy | String? |  |  |
| creator | → User? | `@relation("TaskCreator", fields: [createdBy], references: [id], onDelete: SetNull)` |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |
| planProgress | Int? |  |  |
| planApprovedBy | String? |  |  |
| planApprovedAt | DateTime? |  |  |
| retryCount | Int | `@default(0)` |  |
| maxRetries | Int | `@default(3)` |  |
| nextRetryAt | DateTime? |  |  |
| dependsOn | String[] | `@default([])` | IDs of Task records that must be 'done' before this runs |
| wave | Int? |  | Execution wave (0 = no deps, 1 = depends on wave-0, etc.) — computed at plan approval time |
| claimedBy | String? |  |  |
| claimedAt | DateTime? |  |  |
| heartbeatAt | DateTime? |  |  |
| events | → TaskEvent[] |  |  |
| metadata | Json? |  |  |
| chatRooms | → ChatRoom[] | `@relation("ChatRoomTask")` |  |
| chatMessages | → ChatMessage[] |  |  |
| federatedDispatch | → FederatedDispatch? |  |  |
| vulnerabilityFindings | → VulnerabilityFinding[] |  |  |

`@@index([status, assignedAgent, wave, priority, createdAt])` · `@@index([createdBy])` · `@@index([featureId])` · `@@index([assignedAgent])` · `@@index([status, heartbeatAt])`

### FederatedDispatch

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| taskId | String | `@unique` |  |
| task | → Task | `@relation(fields: [taskId], references: [id], onDelete: Cascade)` |  |
| targetEnvId | String |  | which environment the task was routed to |
| spokeUrl | String |  | URL of the spoke that received it |
| status | String | `@default("dispatched")` | dispatched \| acknowledged \| completed \| failed |
| dispatchedAt | DateTime | `@default(now())` |  |
| acknowledgedAt | DateTime? |  |  |
| completedAt | DateTime? |  |  |
| lastPolledAt | DateTime? |  |  |
| failCount | Int | `@default(0)` |  |

`@@index([targetEnvId])` · `@@index([status])`

### TaskEvent

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| taskId | String |  |  |
| task | → Task | `@relation(fields: [taskId], references: [id], onDelete: Cascade)` |  |
| eventType | String |  |  |
| content | String? | `@db.Text` |  |
| agentId | String? |  |  |
| createdAt | DateTime | `@default(now())` |  |

`@@index([taskId, createdAt])` · `@@index([createdAt])`

### AuditLog

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| userId | String |  |  |
| action | String |  |  |
| target | String |  |  |
| detail | Json? |  |  |
| ipAddress | String? |  | SOC2: [M-005] Source IP for audit trail |
| userAgent | String? |  | SOC2: [M-005] Client user-agent for audit trail |
| createdAt | DateTime | `@default(now())` |  |
| previousHash | String? |  | SOC2: [M-005] Hash chain for tamper-evidence |

`@@index([userId])` · `@@index([createdAt])` · `@@index([userId, createdAt])` · `@@index([ipAddress])`

### SavedView

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| name | String |  |  |
| page | String |  |  |
| filters | Json |  |  |
| createdAt | DateTime | `@default(now())` |  |

### SystemSetting

| Field | Type | Attributes | Notes |
|---|---|---|---|
| key | String | `@id` |  |
| value | Json |  |  |
| updatedAt | DateTime | `@updatedAt` |  |

### SystemPrompt

| Field | Type | Attributes | Notes |
|---|---|---|---|
| key | String | `@id` |  |
| name | String |  |  |
| description | String? | `@db.Text` |  |
| category | String | `@default("system")` |  |
| content | String | `@db.Text` |  |
| variables | Json? |  | Array<{ name: string; description: string }> |
| updatedAt | DateTime | `@updatedAt` |  |

### Note

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| title | String |  |  |
| content | String | `@default("") @db.Text` |  |
| folder | String | `@default("General")` |  |
| pinned | Boolean | `@default(false)` |  |
| type | String | `@default("note")` |  |
| tags | Json? |  | string[] |
| createdBy | String? |  |  |
| creator | → User? | `@relation("NoteCreator", fields: [createdBy], references: [id], onDelete: SetNull)` |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |
| searchVector | Unsupported("tsvector")? |  |  |
| embeddings | → NoteEmbedding[] |  |  |

`@@index([createdBy])`

### NoteEmbedding — table `note_embeddings`

| Field | Type | Attributes | Notes |
|---|---|---|---|
| noteId | String | `@id @default(cuid())` |  |
| note | → Note | `@relation(fields: [noteId], references: [id], onDelete: Cascade)` |  |
| embedding | Unsupported("vector(768)") |  | written/read via raw SQL only — see comment above |
| dimension | Int |  | 1536 (OpenAI) or 768 (Ollama nomic) |
| modelRef | String? |  | which model generated this embedding (ext:xxx ID) |
| version | Int | `@default(1)` | bump when re-embedding |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |

### SemanticConnection — table `semantic_connections`

| Field | Type | Attributes | Notes |
|---|---|---|---|
| sourceNoteId | String |  |  |
| targetNoteId | String |  |  |
| score | Float |  | cosine similarity, 0.0-1.0 |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |

`@@id([sourceNoteId, targetNoteId])` · `@@index([score])`

### User

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| username | String | `@unique` |  |
| email | String | `@unique` |  |
| name | String? |  |  |
| role | String | `@default("user")` | "admin" \| "user" \| "readonly" |
| provider | String | `@default("local")` | "local" \| "authentik" \| "oidc" |
| passwordHash | String? |  |  |
| externalId | String? |  |  |
| active | Boolean | `@default(true)` |  |
| lastSeen | DateTime? |  |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |
| totpSecret | String? |  | Base32 TOTP secret (plaintext legacy — migrate to totpSecretEncrypted) |
| totpEnabled | Boolean | `@default(false)` |  |
| totpRecoveryCodes | String? |  | JSON array of bcrypt-hashed recovery codes (plaintext legacy — migrate to totpRecoveryCodesEncrypted) |
| totpEnabledAt | DateTime? |  | When MFA was enabled (audit trail) |
| totpSecretEncrypted | String? |  | AES-256-GCM encrypted TOTP secret (enc:v1: prefix) |
| totpRecoveryCodesEncrypted | String? |  | AES-256-GCM encrypted JSON array of bcrypt-hashed recovery codes |
| githubTokenEncrypted | String? |  |  |
| githubUsername | String? |  |  |
| githubAllowedRepos | String[] | `@default([])` |  |
| failedLoginAttempts | Int | `@default(0)` |  |
| lockedUntil | DateTime? |  |  |
| lastUsedTotpAt | DateTime? |  |  |
| assignedTasks | → Task[] | `@relation("AssignedUserTasks")` |  |
| assignedBugs | → Bug[] | `@relation("AssignedBugUser")` |  |
| sessions | → Session[] |  |  |
| environmentTiers | → EnvironmentUserTier[] |  |  |
| apiKeys | → ApiKey[] |  |  |
| chatRoomMembers | → ChatRoomMember[] |  |  |
| chatMessages | → ChatMessage[] |  |  |
| managedSecrets | → ManagedSecret[] |  |  |
| notes | → Note[] | `@relation("NoteCreator")` |  |
| agentsCreated | → Agent[] | `@relation("AgentCreator")` |  |
| environmentsCreated | → Environment[] | `@relation("EnvironmentCreator")` |  |
| tasksCreated | → Task[] | `@relation("TaskCreator")` |  |

### ApiKey — table `api_keys`

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(uuid())` |  |
| userId | String |  |  |
| hash | String | `@unique` |  |
| hashPrefix | String |  |  |
| name | String | `@default("Default")` |  |
| expiresAt | DateTime? |  |  |
| lastUsedAt | DateTime? |  |  |
| active | Boolean | `@default(true)` |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |
| user | → User | `@relation(fields: [userId], references: [id], onDelete: Cascade)` |  |

`@@index([userId])`

### Session

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| sessionToken | String | `@unique` |  |
| userId | String |  |  |
| expires | DateTime |  |  |
| user | → User | `@relation(fields: [userId], references: [id], onDelete: Cascade)` |  |

`@@index([userId])`

### VerificationToken

| Field | Type | Attributes | Notes |
|---|---|---|---|
| identifier | String |  |  |
| token | String | `@unique` |  |
| expires | DateTime |  |  |

`@@unique([identifier, token])`

### Bug

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| title | String |  |  |
| description | String? | `@db.Text` |  |
| severity | String | `@default("medium")` | low \| medium \| high \| critical |
| status | String | `@default("open")` | open \| triaged \| in_progress \| resolved \| closed |
| area | String? |  | component/area e.g. "Traefik", "Auth", "Game Servers" |
| reportedBy | String | `@default("admin")` |  |
| assignedUserId | String? |  |  |
| assignedUser | → User? | `@relation("AssignedBugUser", fields: [assignedUserId], references: [id], onDelete: SetNull)` |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |

### ExternalModel

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| name | String |  |  |
| provider | String |  | "openai" \| "ollama" \| "anthropic" \| "custom" |
| baseUrl | String |  |  |
| apiKey | String? | `@db.Text` |  |
| modelId | String |  |  |
| enabled | Boolean | `@default(true)` |  |
| selfHosted | Boolean | `@default(false)` |  |
| inputPricePer1M | Decimal? | `@db.Decimal(10, 6)` | USD per 1M input tokens; for self-hosted = cloud equivalent (savings estimate) |
| outputPricePer1M | Decimal? | `@db.Decimal(10, 6)` | USD per 1M output tokens |
| timeoutSecs | Int | `@default(120)` |  |
| maxTokens | Int? |  |  |
| contextSize | Int? |  |  |
| temperature | Float? |  |  |
| topP | Float? |  |  |
| minP | Float? |  |  |
| repeatPenalty | Float? |  |  |
| seed | Int? |  |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |

### OIDCProvider

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| name | String | `@default("Authentik")` |  |
| enabled | Boolean | `@default(true)` |  |
| issuerUrl | String | `@default("")` |  |
| headerMode | Boolean | `@default(true)` |  |
| groupMapping | Json? |  |  |
| updatedAt | DateTime | `@updatedAt` |  |

### ToolGroup

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| name | String |  |  |
| description | String? |  |  |
| environmentId | String |  |  |
| environment | → Environment | `@relation(fields: [environmentId], references: [id], onDelete: Cascade)` |  |
| minimumTier | String | `@default("viewer")` | "viewer" \| "operator" \| "admin" |
| tools | → ToolGroupTool[] |  |  |
| agentAccess | → AgentGroupToolAccess[] |  |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |

`@@unique([environmentId, name])`

### ToolGroupTool

| Field | Type | Attributes | Notes |
|---|---|---|---|
| toolGroupId | String |  |  |
| toolId | String |  |  |
| toolGroup | → ToolGroup | `@relation(fields: [toolGroupId], references: [id], onDelete: Cascade)` |  |
| tool | → McpTool | `@relation(fields: [toolId], references: [id], onDelete: Cascade)` |  |

`@@id([toolGroupId, toolId])`

### AgentGroup

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| name | String | `@unique` |  |
| description | String? |  |  |
| members | → AgentGroupMember[] |  |  |
| toolAccess | → AgentGroupToolAccess[] |  |  |
| createdAt | DateTime | `@default(now())` |  |

### AgentGroupMember

| Field | Type | Attributes | Notes |
|---|---|---|---|
| agentGroupId | String |  |  |
| agentId | String |  |  |
| agentGroup | → AgentGroup | `@relation(fields: [agentGroupId], references: [id], onDelete: Cascade)` |  |
| agent | → Agent | `@relation(fields: [agentId], references: [id], onDelete: Cascade)` |  |

`@@id([agentGroupId, agentId])`

### AgentGroupToolAccess

| Field | Type | Attributes | Notes |
|---|---|---|---|
| agentGroupId | String |  |  |
| toolGroupId | String |  |  |
| agentGroup | → AgentGroup | `@relation(fields: [agentGroupId], references: [id], onDelete: Cascade)` |  |
| toolGroup | → ToolGroup | `@relation(fields: [toolGroupId], references: [id], onDelete: Cascade)` |  |

`@@id([agentGroupId, toolGroupId])`

### ToolAgentRestriction

| Field | Type | Attributes | Notes |
|---|---|---|---|
| toolId | String |  |  |
| agentId | String |  |  |
| tool | → McpTool | `@relation(fields: [toolId], references: [id], onDelete: Cascade)` |  |
| agent | → Agent | `@relation(fields: [agentId], references: [id], onDelete: Cascade)` |  |

`@@id([toolId, agentId])`

### EnvironmentUserTier

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| userId | String |  |  |
| environmentId | String |  |  |
| tier | String | `@default("viewer")` | "viewer" \| "operator" \| "admin" |
| user | → User | `@relation(fields: [userId], references: [id], onDelete: Cascade)` |  |
| environment | → Environment | `@relation(fields: [environmentId], references: [id], onDelete: Cascade)` |  |

`@@unique([userId, environmentId])`

### ToolApprovalRequest

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| conversationId | String |  |  |
| userId | String |  |  |
| environmentId | String |  |  |
| toolName | String |  |  |
| toolArgs | Json | `@default("{}")` |  |
| reason | String? |  |  |
| status | String | `@default("pending")` | "pending" \| "approved" \| "denied" |
| approvedBy | String? |  |  |
| adminNote | String? |  |  |
| createdAt | DateTime | `@default(now())` |  |
| resolvedAt | DateTime? |  |  |

### ToolExecutionGrant

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| userId | String |  |  |
| environmentId | String |  |  |
| toolName | String |  |  |
| expiresAt | DateTime |  |  |
| usedAt | DateTime? |  |  |
| createdAt | DateTime | `@default(now())` |  |

### Domain

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| name | String | `@unique` | e.g. "khalisio.com" |
| type | String | `@default("public")` | "public" \| "internal" |
| notes | String? | `@db.Text` |  |
| coreDnsEnvironmentId | String? |  |  |
| coreDnsIp | String? |  |  |
| coreDnsStatus | String | `@default("none")` | "none" \| "bootstrapped" \| "error" |
| coreDnsEnvironment | → Environment? | `@relation("DomainCoreDns", fields: [coreDnsEnvironmentId], references: [id], onDelete: SetNull)` |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |
| ingressPoints | → IngressPoint[] |  |  |
| dnsRecords | → DnsRecord[] |  |  |

### DnsRecord

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| domainId | String |  |  |
| ip | String |  |  |
| hostnames | String[] |  |  |
| enabled | Boolean | `@default(true)` |  |
| comment | String? |  |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |
| domain | → Domain | `@relation(fields: [domainId], references: [id], onDelete: Cascade)` |  |

`@@index([domainId])`

### IngressPoint

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| domainId | String |  |  |
| environmentId | String? |  |  |
| name | String |  |  |
| type | String | `@default("traefik")` | "traefik" \| "nginx" \| "cilium" \| "haproxy" \| "cloudflare-tunnel" \| "other" |
| ip | String? |  |  |
| port | Int | `@default(443)` |  |
| certManager | Boolean | `@default(true)` |  |
| clusterIssuer | String? |  |  |
| status | String | `@default("pending")` | "pending" \| "bootstrapped" \| "error" |
| comment | String? | `@db.Text` |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |
| domain | → Domain | `@relation(fields: [domainId], references: [id], onDelete: Cascade)` |  |
| environment | → Environment? | `@relation(fields: [environmentId], references: [id], onDelete: SetNull)` |  |
| routes | → IngressRoute[] |  |  |
| middlewares | → IngressMiddleware[] |  |  |

`@@index([domainId])` · `@@index([environmentId])`

### IngressRoute

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| ingressPointId | String |  |  |
| host | String |  |  |
| paths | Json | `@default("[]")` | [{path: "/", service: "svc-name", port: 80, namespace: "apps"}] |
| tls | Boolean | `@default(true)` |  |
| middlewares | String[] | `@default([])` | names of IngressMiddleware to apply |
| comment | String? | `@db.Text` |  |
| enabled | Boolean | `@default(true)` |  |
| disabledAt | DateTime? |  |  |
| disabledBy | String? |  |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |
| ingressPoint | → IngressPoint | `@relation(fields: [ingressPointId], references: [id], onDelete: Cascade)` |  |

### BackgroundJob

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id` |  |
| type | String |  | 'storage-bootstrap' \| 'ingress-bootstrap' |
| title | String |  |  |
| status | String | `@default("queued")` | queued \| running \| completed \| failed |
| logs | String[] | `@default([])` |  |
| environmentId | String? |  |  |
| metadata | Json? |  |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |
| completedAt | DateTime? |  |  |
| archivedAt | DateTime? |  |  |
| ownerId | String? |  |  |
| heartbeatAt | DateTime? |  |  |
| dedupeKey | String? | `@unique` |  |

`@@index([status, heartbeatAt])`

### IngressMiddleware

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| ingressPointId | String |  |  |
| name | String |  | e.g. "crowdsec-bouncer", "authentik-forward-auth" |
| type | String |  | "crowdsec" \| "forward-auth" \| "rate-limit" \| "basic-auth" \| "headers" \| "custom" |
| config | Json | `@default("{}")` | provider URL, secret ref, namespace, etc. |
| enabled | Boolean | `@default(true)` |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |
| ingressPoint | → IngressPoint | `@relation(fields: [ingressPointId], references: [id], onDelete: Cascade)` |  |

`@@unique([ingressPointId, name])`

### Nova — table `nova`

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| name | String | `@unique` | e.g. "cluster-monitor", "grafana", "excalidraw" |
| displayName | String |  |  |
| description | String? | `@db.Text` |  |
| category | String | `@default("Other")` | Identity \| Storage \| Monitoring \| DevTools \| Other \| Agent |
| version | String | `@default("1.0.0")` | version of the nova definition |
| source | String | `@default("bundled")` | bundled \| remote \| user-created |
| config | Json |  | Full NovaConfig: { type, name, displayName, helm?, overlaySecret?, deployments?, waitForReady?, cleanup?, manifests?, rawValues?, systemPrompt?, contextConfig? } |
| tags | String[] | `@default([])` | ["collaboration", "whiteboard", "monitoring"] |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |
| deployments | → NovaDeployment[] |  |  |
| revisions | → NovaRevision[] |  |  |
| agents | → Agent[] |  |  |

### NovaDeployment

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| novaId | String |  |  |
| nova | → Nova | `@relation(fields: [novaId], references: [id], onDelete: Cascade)` |  |
| environmentId | String? |  |  |
| environment | → Environment? | `@relation(fields: [environmentId], references: [id], onDelete: SetNull)` |  |
| agentId | String? |  |  |
| agent | → Agent? | `@relation(fields: [agentId], references: [id], onDelete: SetNull)` |  |
| deployedAt | DateTime | `@default(now())` |  |
| status | String | `@default("deployed")` | deployed \| degraded \| error \| upgrading |
| version | String |  | version of nova that was deployed |
| metadata | Json? |  | runtime info: ingress URLs, namespaces, etc. |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |

`@@unique([novaId, environmentId])` · `@@index([novaId])` · `@@index([environmentId])` · `@@index([agentId])`

### NovaRevision

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| novaId | String |  |  |
| nova | → Nova | `@relation(fields: [novaId], references: [id], onDelete: Cascade)` |  |
| version | String |  |  |
| diff | String | `@db.Text` | JSON diff from previous version |
| createdBy | String |  | "admin" \| agentId \| "system" |
| reasoning | String? | `@db.Text` |  |
| createdAt | DateTime | `@default(now())` |  |

`@@index([novaId, version])`

### ChatRoom — table `chat_rooms`

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| name | String |  |  |
| description | String? | `@db.Text` |  |
| type | String | `@default("task")` |  |
| taskId | String? |  |  |
| task | → Task? | `@relation("ChatRoomTask", fields: [taskId], references: [id], onDelete: SetNull)` |  |
| featureId | String? |  |  |
| feature | → Feature? | `@relation("FeatureChatRooms", fields: [featureId], references: [id], onDelete: SetNull)` |  |
| epicId | String? |  |  |
| epic | → Epic? | `@relation("EpicChatRooms", fields: [epicId], references: [id], onDelete: SetNull)` |  |
| createdBy | String |  |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |
| tokenCount | Int | `@default(0)` | rolling prompt_tokens from last LLM turn |
| tokenLimit | Int? |  | override context limit; null = auto-discover from model |
| members | → ChatRoomMember[] |  |  |
| messages | → ChatMessage[] |  |  |
| metadata | Json? |  | { ringLeaderAgentId?: string, knowledgeScope: "global" \| "room" \| "mixed" } |
| roomKnowledge | → RoomKnowledge[] |  |  |
| goals | → RoomGoal[] |  |  |

`@@unique([featureId])` · `@@index([taskId])` · `@@index([epicId])`

### RoomGoal — table `room_goals`

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| roomId | String |  |  |
| room | → ChatRoom | `@relation(fields: [roomId], references: [id], onDelete: Cascade)` |  |
| text | String | `@db.Text` |  |
| status | String | `@default("active")` | "active" \| "completed" \| "abandoned" |
| completionSummary | String? | `@db.Text` |  |
| startMessageId | String? |  | ID of the "goal set" system ChatMessage — for future jump-to |
| setBy | String? |  | userId or agentId that created this goal |
| createdAt | DateTime | `@default(now())` |  |
| completedAt | DateTime? |  |  |

`@@index([roomId, status])` · `@@index([roomId, createdAt])`

### ChatRoomMember — table `chat_room_members`

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| roomId | String |  |  |
| room | → ChatRoom | `@relation(fields: [roomId], references: [id], onDelete: Cascade)` |  |
| agentId | String? |  |  |
| userId | String? |  |  |
| role | String | `@default("member")` | "lead" \| "member" \| "readonly" |
| joinedAt | DateTime | `@default(now())` |  |
| lastReadAt | DateTime? |  |  |
| agent | → Agent? | `@relation(fields: [agentId], references: [id], onDelete: Cascade)` |  |
| user | → User? | `@relation(fields: [userId], references: [id], onDelete: Cascade)` |  |

`@@unique([roomId, agentId])` · `@@unique([roomId, userId])`

### ChatMessage — table `chat_messages`

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| roomId | String |  |  |
| room | → ChatRoom | `@relation(fields: [roomId], references: [id], onDelete: Cascade)` |  |
| agentId | String? |  |  |
| userId | String? |  |  |
| taskId | String? |  |  |
| senderType | String |  | "agent" \| "human" \| "system" |
| content | String | `@db.Text` |  |
| attachments | Json? |  |  |
| incidentId | String? |  |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |
| agent | → Agent? | `@relation(fields: [agentId], references: [id], onDelete: SetNull)` |  |
| user | → User? | `@relation(fields: [userId], references: [id], onDelete: SetNull)` |  |
| task | → Task? | `@relation(fields: [taskId], references: [id], onDelete: SetNull)` |  |
| incident | → Incident? | `@relation(fields: [incidentId], references: [id], onDelete: SetNull)` |  |

`@@index([roomId, createdAt])` · `@@index([roomId, taskId, createdAt])` · `@@index([incidentId])` · `@@index([agentId])` · `@@index([userId])` · `@@index([taskId])`

### ManagedSecret — table `managed_secrets`

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| environmentId | String |  |  |
| environment | → Environment | `@relation(fields: [environmentId], references: [id], onDelete: Cascade)` |  |
| name | String |  | ExternalSecret CRD name (becomes K8s secret name by default) |
| namespace | String | `@default("default")` |  |
| description | String? | `@db.Text` |  |
| secretStore | String | `@default("vault-backend")` | SecretStore or ClusterSecretStore name |
| secretStoreKind | String | `@default("ClusterSecretStore")` | "SecretStore" \| "ClusterSecretStore" |
| remoteRef | String |  | Vault path e.g. "secret/data/myapp/db" |
| targetSecretName | String? |  | Override K8s secret name (defaults to `name`) |
| refreshInterval | String | `@default("1h")` | ESO sync interval |
| dataKeys | Json | `@default("[]")` |  |
| tags | Json | `@default("[]")` |  |
| status | String | `@default("draft")` | "draft" \| "applied" \| "error" |
| statusMessage | String? | `@db.Text` |  |
| appliedAt | DateTime? |  |  |
| createdBy | String? |  |  |
| creator | → User? | `@relation(fields: [createdBy], references: [id], onDelete: SetNull)` |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |

`@@index([environmentId])`

### SecurityEvent

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(uuid())` |  |
| environmentId | String? |  |  |
| environment | → Environment? | `@relation(fields: [environmentId], references: [id], onDelete: SetNull)` |  |
| type | String |  | 'crowdsec_block', 'ntopng_threat', 'wazuh_alert', 'anomaly', 'source_stale' |
| source | String |  | 'crowdsec', 'ntopng', 'wazuh', 'elk' |
| severity | Int |  | 0-100 |
| title | String |  |  |
| description | String? | `@db.Text` |  |
| rawEvent | Json |  | full event payload |
| dedupKey | String |  | hash for dedup |
| acknowledged | Boolean | `@default(false)` |  |
| acknowledgedAt | DateTime? |  |  |
| acknowledgedBy | String? |  |  |
| incidentId | String? |  | Linked incident (if correlated) |
| incident | → Incident? | `@relation(fields: [incidentId], references: [id], onDelete: SetNull)` |  |
| firstSeen | DateTime? |  | When this event was first observed |
| lastSeen | DateTime? |  | When this event was last observed (updated by dedup) |
| scannedAt | DateTime? |  |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |

`@@index([environmentId, createdAt])` · `@@index([environmentId, type, acknowledged])` · `@@index([incidentId])` · `@@index([dedupKey])` · `@@index([type, scannedAt])`

### SecurityConfig

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(uuid())` |  |
| environmentId | String? |  |  |
| environment | → Environment? | `@relation(fields: [environmentId], references: [id], onDelete: SetNull)` |  |
| key | String |  |  |
| value | String |  |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |

`@@unique([environmentId, key])`

### Incident

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(uuid())` |  |
| environmentId | String? |  |  |
| environment | → Environment? | `@relation(fields: [environmentId], references: [id], onDelete: SetNull)` |  |
| status | String | `@default("open")` | "open" \| "triaged" \| "contained" \| "closed" |
| severity | Int |  | 0-100, inherited from highest-severity correlated event |
| rootCauseSummary | String? | `@db.Text` | Free-text explanation (populated by Warden) |
| attackerKey | String? |  | External identifier for the attacker (IP, user, host) |
| hostKey | String? |  | Internal identifier for the affected host |
| openedAt | DateTime | `@default(now())` |  |
| closedAt | DateTime? |  |  |
| updatedAt | DateTime | `@updatedAt` |  |
| events | → SecurityEvent[] |  |  |
| actionAudits | → ActionAudit[] |  |  |
| containmentRequests | → ContainmentRequest[] |  |  |
| chatMessages | → ChatMessage[] |  |  |
| investigation | → Investigation? | `@relation(fields: [investigationId], references: [id], onDelete: SetNull)` |  |
| investigationId | String? |  | Soft back-reference to investigation case |
| triageDispatchedAt | DateTime? |  |  |

`@@index([environmentId, status])` · `@@index([environmentId, severity])` · `@@index([investigationId])`

### ContainmentRequest

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(uuid())` |  |
| incidentId | String |  |  |
| incident | → Incident | `@relation(fields: [incidentId], references: [id], onDelete: Cascade)` |  |
| action | String |  |  |
| justification | String |  |  |
| status | ContainmentStatus | `@default(pending)` |  |
| requestedBy | String |  |  |
| reviewedBy | String? |  |  |
| reviewedAt | DateTime? |  |  |
| createdAt | DateTime | `@default(now())` |  |

`@@index([incidentId])` · `@@index([status])`

### ActionAudit

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(uuid())` |  |
| environmentId | String? |  |  |
| environment | → Environment? | `@relation(fields: [environmentId], references: [id], onDelete: SetNull)` |  |
| incidentId | String? |  |  |
| incident | → Incident? | `@relation(fields: [incidentId], references: [id], onDelete: SetNull)` |  |
| policyId | String? |  |  |
| policy | → ActionPolicy? | `@relation(fields: [policyId], references: [id], onDelete: SetNull)` |  |
| actionType | String |  | matches ActionPolicy.actionType |
| target | String |  | target pattern (IP, CIDR, hostname, etc.) |
| tier | String |  | tier at time of decision: "auto" \| "approve" \| "escalate" \| "notify" |
| proposedBy | String |  | "warden" \| "system" \| operator username |
| approvedBy | String? |  | operator username who approved; null for auto/notify |
| status | String |  | "attempting" \| "succeeded" \| "failed" \| "denied" |
| payload | Json? |  | full action request payload |
| result | String? | `@db.Text` | action outcome or error message |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |

`@@index([incidentId])` · `@@index([status])` · `@@index([tier])`

### ActionPolicy

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(uuid())` |  |
| environmentId | String? |  |  |
| environment | → Environment? | `@relation(fields: [environmentId], references: [id], onDelete: SetNull)` |  |
| actionType | String | `@unique` | e.g. "crowdsec_decision_create", "__panic_mode__" |
| defaultTier | String |  | "auto" \| "approve" \| "escalate" \| "notify" |
| targetPatterns | Json? |  | null or [{ pattern: string; tier: string; operator?: "strict" \| "subnet" }] |
| updatedBy | String? |  | "system" \| operator username |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |
| auditRows | → ActionAudit[] |  |  |

`@@index([actionType])` · `@@index([environmentId])`

### CorrelationRule

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(uuid())` |  |
| environmentId | String? |  |  |
| environment | → Environment? | `@relation(fields: [environmentId], references: [id], onDelete: SetNull)` |  |
| name | String | `@unique` | e.g. "brute_force", "port_scan", "malware" |
| enabled | Boolean | `@default(true)` |  |
| ruleType | String |  | "threshold" \| "pattern" \| "malware" \| "process" |
| params | Json |  | rule-specific params (window, threshold, etc.) |
| severity | Int |  | default severity for generated incidents (0-100) |
| window | Int |  | time window in seconds for rule evaluation |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |

`@@index([enabled])` · `@@index([environmentId])`

### SourceHealth

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(uuid())` |  |
| environmentId | String? |  |  |
| environment | → Environment? | `@relation(fields: [environmentId], references: [id], onDelete: SetNull)` |  |
| source | String | `@unique` | "crowdsec" \| "wazuh" \| "elk_syslog" \| "elk_flow" \| "ntopng" |
| lastSeenAt | DateTime? |  |  |
| lastWatermark | DateTime? |  | highest watermark advanced by poller |
| staleAfterMs | Int |  | milliseconds before source is considered stale |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |

`@@index([source])` · `@@index([environmentId])`

### EnvironmentSourceHealth

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(uuid())` |  |
| environmentId | String |  |  |
| environment | → Environment | `@relation(fields: [environmentId], references: [id], onDelete: Cascade)` |  |
| source | String |  | "falco" \| "k8s_events" |
| lastSeenAt | DateTime? |  |  |
| lastWatermark | String? |  | K8s resourceVersion (string) — null for push-based Falco |
| staleAfterMs | Int |  |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |

`@@unique([environmentId, source])` · `@@index([source])` · `@@index([environmentId])`

### VulnerabilityFinding

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| environmentId | String |  |  |
| environment | → Environment | `@relation(fields: [environmentId], references: [id], onDelete: Cascade)` |  |
| target | String |  |  |
| packageName | String |  |  |
| packageVersion | String |  |  |
| fixedVersion | String? |  |  |
| cveId | String |  |  |
| cvssScore | Float? |  |  |
| cvssVector | String? |  |  |
| attackVector | String? |  | NETWORK / ADJACENT / LOCAL / PHYSICAL |
| attackComplexity | String? |  |  |
| epssScore | Float? |  |  |
| epssPercentile | Float? |  |  |
| isKev | Boolean | `@default(false)` |  |
| kevDueDate | DateTime? |  |  |
| severity | Int |  | 0-100, computed via attack-vector formula |
| status | VulnStatus | `@default(open)` |  |
| firstSeenAt | DateTime | `@default(now())` |  |
| lastSeenAt | DateTime | `@updatedAt` |  |
| fixedAt | DateTime? |  |  |
| rawScanner | Json |  | full scanner vulnerability object (for forensics) |
| title | String? |  |  |
| description | String? | `@db.Text` |  |
| fixAvailable | Boolean | `@default(false)` |  |
| taskId | String? |  |  |
| task | → Task? | `@relation(fields: [taskId], references: [id], onDelete: SetNull)` |  |
| acceptedRiskJustification | String? | `@db.Text` |  |
| acceptedRiskExpiresAt | DateTime? |  |  |
| scanId | String? |  |  |
| scan | → VulnerabilityScan? | `@relation(fields: [scanId], references: [id], onDelete: SetNull)` |  |

`@@unique([environmentId, target, cveId, packageName])` · `@@index([environmentId])` · `@@index([cveId])` · `@@index([isKev])` · `@@index([status])` · `@@index([severity])` · `@@index([taskId])` · `@@index([scanId])`

### VulnerabilityScan

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| environmentId | String |  |  |
| environment | → Environment | `@relation(fields: [environmentId], references: [id], onDelete: Cascade)` |  |
| driver | String | `@default("trivy")` |  |
| status | String | `@default("pending")` |  |
| triggeredBy | String? |  |  |
| startedAt | DateTime | `@default(now())` |  |
| completedAt | DateTime? |  |  |
| errorMessage | String? | `@db.Text` |  |
| findingsCreated | Int | `@default(0)` |  |
| findingsEscalated | Int | `@default(0)` |  |
| findingsFixed | Int | `@default(0)` |  |
| findings | → VulnerabilityFinding[] |  |  |

`@@index([environmentId, startedAt])` · `@@index([status])`

### Suppression

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(uuid())` |  |
| environmentId | String? |  |  |
| environment | → Environment? | `@relation(fields: [environmentId], references: [id], onDelete: SetNull)` |  |
| matchPattern | Json |  | { type: "ip" \| "cidr" \| "host" \| "pattern"; value: string } |
| reason | String | `@db.Text` |  |
| expiresAt | DateTime? |  | null = permanent |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |

`@@index([expiresAt])` · `@@index([environmentId])`

### AgentProfile — table `agent_profiles`

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| agentId | String |  |  |
| agent | → Agent | `@relation(fields: [agentId], references: [id], onDelete: Cascade)` |  |
| domain | String |  |  |
| description | String | `@db.Text` |  |
| tags | String[] | `@default([])` |  |
| activeEnvironments | String[] | `@default([])` |  |
| confidence | Float | `@default(0.5)` |  |
| verifiedAt | DateTime? |  |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |

`@@unique([agentId])` · `@@index([domain])` · `@@index([tags])`

### RoomKnowledge — table `room_knowledge`

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| roomId | String |  |  |
| room | → ChatRoom | `@relation(fields: [roomId], references: [id], onDelete: Cascade)` |  |
| title | String |  |  |
| content | String | `@db.Text` |  |
| type | String | `@default("note")` | "note" \| "runbook" \| "context" \| "decision" |
| tags | Json? |  | string[] |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |

`@@unique([roomId, title])` · `@@index([roomId])` · `@@index([tags])`

### AgentKnowledge — table `agent_knowledge`

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| agentId | String |  |  |
| agent | → Agent | `@relation(fields: [agentId], references: [id], onDelete: Cascade)` |  |
| title | String |  |  |
| content | String | `@db.Text` |  |
| type | String | `@default("note")` | "note" \| "runbook" \| "context" \| "lesson" |
| tags | Json? |  | string[] |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |

`@@unique([agentId, title])` · `@@index([agentId])` · `@@index([tags])`

### NovaDefinition

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| name | String | `@unique` |  |
| category | String |  | "skill" \| "hook" |
| version | String | `@default("1.0")` |  |
| title | String |  |  |
| description | String | `@db.Text` |  |
| spec | String | `@db.Text` | JSON string |
| metadata | String? | `@db.Text` | JSON string |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |
| instances | → NebulaInstance[] |  |  |

`@@index([category])`

### NebulaInstance

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| environmentId | String |  |  |
| environment | → Environment | `@relation(fields: [environmentId], references: [id], onDelete: Cascade)` |  |
| sourceNovaId | String? |  |  |
| novaDefinition | → NovaDefinition? | `@relation(fields: [sourceNovaId], references: [id], onDelete: SetNull)` |  |
| name | String |  |  |
| category | String |  | "skill" \| "hook" |
| spec | String | `@db.Text` |  |
| isForked | Boolean | `@default(false)` |  |
| isInstalled | Boolean | `@default(true)` |  |
| minimumTier | String? |  |  |
| source | String | `@default("human")` |  |
| createdByAgentId | String? |  |  |
| createdByAgent | → Agent? | `@relation(fields: [createdByAgentId], references: [id], onDelete: SetNull)` |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |
| hookLogs | → HookExecutionLog[] |  |  |
| skillLogs | → SkillExecutionLog[] |  |  |
| embedding | → NebulaEmbedding? |  |  |

`@@unique([environmentId, name])` · `@@index([environmentId, category, isInstalled])` · `@@index([createdByAgentId])`

### NebulaEmbedding — table `nebula_embeddings`

| Field | Type | Attributes | Notes |
|---|---|---|---|
| nebulaId | String | `@id` |  |
| nebula | → NebulaInstance | `@relation(fields: [nebulaId], references: [id], onDelete: Cascade)` |  |
| embedding | Unsupported("vector(768)") |  | written/read via raw SQL only |
| dimension | Int |  | 1536 (OpenAI) or 768 (Ollama nomic) |
| modelRef | String? |  | which model generated this embedding (ext:xxx ID) |
| version | Int | `@default(1)` | bump when re-embedding |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |

### HookExecutionLog

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| nebulaId | String |  |  |
| nebula | → NebulaInstance | `@relation(fields: [nebulaId], references: [id], onDelete: Cascade)` |  |
| triggerEvent | String |  |  |
| triggerData | String? | `@db.Text` |  |
| actionType | String |  |  |
| status | String | `@default("running")` |  |
| output | String? | `@db.Text` |  |
| startedAt | DateTime | `@default(now())` |  |
| completedAt | DateTime? |  |  |
| durationMs | Int? |  |  |

`@@index([nebulaId, startedAt])` · `@@index([status, startedAt])` · `@@index([startedAt])`

### SkillExecutionLog

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| nebulaId | String |  |  |
| nebula | → NebulaInstance | `@relation(fields: [nebulaId], references: [id], onDelete: Cascade)` |  |
| source | String |  | "chat_match" \| "task_match" \| "room_match" \| "hook_trigger" \| "manual" |
| contextId | String? |  |  |
| matchedPattern | String? |  |  |
| createdAt | DateTime | `@default(now())` |  |

`@@index([nebulaId, createdAt])` · `@@index([createdAt])`

### AgentTrace

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| conversationId | String? |  |  |
| taskId | String? |  |  |
| step | Int |  |  |
| type | String |  | "tool_call" \| "tool_result" \| "skill_injected" \| "hook_triggered" \| "text_generation" \| "error" |
| toolName | String? |  |  |
| toolArgs | String? | `@db.Text` |  |
| toolResult | String? | `@db.Text` |  |
| content | String? | `@db.Text` |  |
| skillName | String? |  |  |
| hookName | String? |  |  |
| durationMs | Int? |  |  |
| modelUsed | String? |  |  |
| systemPromptHash | String? |  |  |
| fullContext | String? | `@db.Text` |  |
| tokensIn | Int? |  |  |
| tokensOut | Int? |  |  |
| costCents | Decimal? | `@db.Decimal(10, 6)` |  |
| createdAt | DateTime | `@default(now())` |  |

`@@index([conversationId, step])` · `@@index([taskId, step])` · `@@index([type, createdAt])` · `@@index([createdAt])`

### Eval

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| environmentId | String |  |  |
| environment | → Environment | `@relation(fields: [environmentId], references: [id], onDelete: Cascade)` |  |
| targetType | String |  | "conversation" \| "task" \| "skill" \| "hook" |
| targetId | String |  |  |
| evalType | String |  | "manual" \| "auto_rule" \| "auto_llm" |
| evaluator | String? |  |  |
| rulesetId | String? |  |  |
| scores | String | `@db.Text` | JSON |
| scoreTotal | Float |  | 0-100 |
| scoreBreakdown | String? | `@db.Text` | JSON |
| feedback | String? | `@db.Text` |  |
| evidence | String? | `@db.Text` | JSON |
| createdAt | DateTime | `@default(now())` |  |

`@@index([environmentId, targetType, targetId])` · `@@index([evalType, createdAt])`

### Ruleset

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| name | String | `@unique` |  |
| description | String | `@db.Text` |  |
| criteria | String | `@db.Text` | JSON |
| triggers | String | `@db.Text` | JSON |
| createdAt | DateTime | `@default(now())` |  |

`@@index([name])`

### Nebula

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| name | String | `@unique` |  |
| displayName | String |  |  |
| description | String? | `@db.Text` |  |
| gitUrl | String |  |  |
| branch | String | `@default("main")` |  |
| path | String | `@default("novas")` |  |
| isSystem | Boolean | `@default(false)` |  |
| lastSyncAt | DateTime? |  |  |
| syncStatus | String | `@default("pending")` |  |
| syncError | String? | `@db.Text` |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |

### AgentScore

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| environmentId | String |  |  |
| environment | → Environment | `@relation(fields: [environmentId], references: [id], onDelete: Cascade)` |  |
| targetType | String |  | "conversation" \| "task" \| "skill" \| "hook" |
| targetId | String |  |  |
| scoreTotal | Float |  | 0-100 |
| accuracy | Float |  | 0-100 |
| completeness | Float? |  | 0-100 |
| safety | Float |  | 0-100 |
| efficiency | Float? |  | 0-100 |
| quality | Float? |  | 0-100 |
| evalCount | Int | `@default(0)` |  |
| lastEvalAt | DateTime? |  |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |

`@@unique([targetType, targetId])`

### Investigation

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(uuid())` |  |
| name | String |  |  |
| status | InvestigationStatus | `@default(open)` |  |
| severity | Int |  | 0-100, derived from linked incidents; manually overridable |
| tlp | TLP | `@default(amber)` |  |
| pap | Int | `@default(2)` | 0-3, Permissible Actions Protocol |
| startedAt | DateTime | `@default(now())` |  |
| resolvedAt | DateTime? |  |  |
| closedAt | DateTime? |  |  |
| resolution | String? |  | markdown summary of what happened |
| resolutionType | ResolutionType? |  |  |
| assignedTo | String? |  | userId or null (unassigned) |
| createdBy | String |  | userId or "warden" |
| tags | String[] | `@default([])` |  |
| dueAt | DateTime? |  | SLA deadline |
| mitreAttackIds | String[] | `@default([])` | e.g. ["T1110", "T1046"] |
| externalId | String? |  | TheHive case ID (e.g. "TH-0001") |
| externalSystem | String? |  | "thehive" |
| lastSyncedAt | DateTime? |  |  |
| syncVersion | Int | `@default(0)` | increment on each sync cycle |
| syncSource | String? |  | last write origin: "orion" \| "thehive" |
| timeToDetect | Int? |  | seconds from first event to incident creation |
| timeToRespond | Int? |  | seconds from incident to investigation open |
| timeToResolve | Int? |  | seconds from investigation open to resolved |
| incidents | → Incident[] |  |  |
| notes | → InvestigationNote[] |  |  |
| observables | → InvestigationObservable[] |  |  |
| timeline | → InvestigationTimeline[] |  |  |
| auditLog | → InvestigationAudit[] |  |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |

`@@index([status])` · `@@index([createdAt])` · `@@index([externalId])`

### InvestigationNote

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(uuid())` |  |
| investigation | → Investigation | `@relation(fields: [investigationId], references: [id], onDelete: Cascade)` |  |
| investigationId | String |  |  |
| content | String |  | markdown; stored separately from Warden-generated content |
| author | String |  | userId or "warden" |
| authorType | String |  | "human" \| "warden" — never mix in query results |
| isDraft | Boolean | `@default(false)` | human-private draft |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime? | `@updatedAt` |  |
| searchVector | Unsupported("tsvector")? |  | GIN index for full-text search |

`@@index([investigationId, createdAt])` · `@@index([investigationId, authorType])`

### InvestigationObservable

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(uuid())` |  |
| investigation | → Investigation | `@relation(fields: [investigationId], references: [id], onDelete: Cascade)` |  |
| investigationId | String |  |  |
| value | String |  | canonical defanged form (e.g. 1.2.3.4, evil[.]com) |
| displayValue | String |  | original as found (e.g. hxxp://evil[.]com/path) |
| category | ObservableCategory |  |  |
| role | ObservableRole | `@default(ioc)` |  |
| verdict | ObservableVerdict | `@default(unknown)` |  |
| verdictBy | String? |  | userId, "warden", "cortex" |
| verdictAt | DateTime? |  |  |
| confidence | Int | `@default(0)` | 0-100 |
| severity | Int | `@default(0)` | relevance to this investigation |
| firstSeen | DateTime | `@default(now())` |  |
| lastSeen | DateTime | `@updatedAt` |  |
| context | String? |  | where it was found; which incident, which log line |
| resolved | Boolean | `@default(false)` |  |
| threatIntelMatch | Json? |  | enrichment from TheHive/Cortex |
| externalId | String? |  |  |
| lastSyncedAt | DateTime? |  |  |

`@@unique([investigationId, value, category])` · `@@index([value])` · `@@index([category])` · `@@index([verdict])`

### InvestigationTimeline

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(uuid())` |  |
| investigation | → Investigation | `@relation(fields: [investigationId], references: [id], onDelete: Cascade)` |  |
| investigationId | String |  |  |
| eventTime | DateTime |  | WHEN the event occurred (not when the entry was created) |
| createdAt | DateTime | `@default(now())` |  |
| eventType | String |  | incident_created \| observable_added \| note_added \| status_changed \| action_taken \| warden_annotation \| merge_source \| merge_target \| link_added \| link_removed \| thehive_sync \| observable_verdict_set |
| title | String |  |  |
| description | String? |  |  |
| source | String |  | "manual" \| "warden" \| "correlator" \| "thehive" |
| isPinned | Boolean | `@default(false)` | analyst can pin key events |
| payload | Json? |  | structured event data |

`@@index([investigationId, eventTime])` · `@@index([investigationId, eventType])` · `@@index([createdAt])`

### InvestigationAudit

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(uuid())` |  |
| investigation | → Investigation | `@relation(fields: [investigationId], references: [id], onDelete: Cascade)` |  |
| investigationId | String |  |  |
| actorId | String |  | userId or "warden" or "system" |
| actorType | String |  | "human" \| "warden" \| "system" |
| action | String |  | status_changed \| note_added \| observable_added \| merge \| link_added \| severity_changed |
| before | Json? |  | previous value |
| after | Json? |  | new value |
| timestamp | DateTime | `@default(now())` |  |

`@@index([investigationId, timestamp])`

### TaskCheckpoint

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| taskId | String |  |  |
| stepIndex | Int |  |  |
| toolName | String |  |  |
| argsHash | String |  |  |
| result | String | `@db.Text` |  |
| createdAt | DateTime | `@default(now())` |  |

`@@unique([taskId, stepIndex])` · `@@index([taskId])`

### ToolExecution

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| executionId | String | `@unique` | client UUID — duplicate POST returns existing row, never re-executes |
| environmentId | String? |  | null = localhost/management-host |
| tool | String |  | "shell_exec" \| "file_read" \| "system_info" |
| args | Json |  | redacted before storage — no secrets in DB |
| actorId | String |  | agentId or userId (server-attested by gateway, not client-asserted) |
| actorType | String |  | "agent" \| "human" |
| riskTier | String |  | "auto" \| "notify" \| "approve" \| "escalate" |
| status | String |  | "pending" \| "running" \| "completed" \| "failed" \| "denied" |
| exitCode | Int? |  |  |
| output | String? |  | stdout+stderr, truncated to 10k, secrets redacted |
| durationMs | Int? |  |  |
| reviewerId | String? |  |  |
| reviewDecision | String? |  | "approved" \| "denied" |
| reviewedAt | DateTime? |  |  |
| expiresAt | DateTime? |  | set for approve/escalate — auto-deny when reached |
| createdAt | DateTime | `@default(now())` |  |
| completedAt | DateTime? |  |  |
| environment | → Environment? | `@relation(fields: [environmentId], references: [id], onDelete: SetNull)` |  |

`@@index([actorId, createdAt])` · `@@index([status, createdAt])` · `@@index([tool, createdAt])` · `@@index([expiresAt])` · `@@index([environmentId])` · `@@index([createdAt])`

### EvalSuite

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| name | String | `@unique` |  |
| description | String? |  |  |
| agentId | String? |  |  |
| agent | → Agent? | `@relation("EvalSuiteAgent", fields: [agentId], references: [id], onDelete: SetNull)` |  |
| cases | → EvalCase[] |  |  |
| runs | → EvalRun[] |  |  |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |

`@@index([agentId])`

### EvalCase

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| suiteId | String |  |  |
| suite | → EvalSuite | `@relation(fields: [suiteId], references: [id], onDelete: Cascade)` |  |
| title | String |  |  |
| prompt | String | `@db.Text` |  |
| expectedOutput | String? | `@db.Text` |  |
| assertions | String | `@db.Text` | JSON array of assertion objects |
| weight | Int | `@default(1)` |  |
| createdAt | DateTime | `@default(now())` |  |
| results | → EvalCaseResult[] |  |  |

`@@index([suiteId])`

### EvalRun

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| suiteId | String |  |  |
| suite | → EvalSuite | `@relation(fields: [suiteId], references: [id], onDelete: Cascade)` |  |
| agentId | String |  |  |
| agent | → Agent | `@relation("EvalRunAgent", fields: [agentId], references: [id], onDelete: Cascade)` |  |
| modelId | String |  |  |
| status | String | `@default("pending")` |  |
| scoreTotal | Float? |  |  |
| passCount | Int | `@default(0)` |  |
| failCount | Int | `@default(0)` |  |
| results | → EvalCaseResult[] |  |  |
| startedAt | DateTime? |  |  |
| completedAt | DateTime? |  |  |
| createdAt | DateTime | `@default(now())` |  |

`@@index([suiteId])` · `@@index([agentId])`

### EvalCaseResult

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| runId | String |  |  |
| run | → EvalRun | `@relation(fields: [runId], references: [id], onDelete: Cascade)` |  |
| caseId | String |  |  |
| case | → EvalCase | `@relation(fields: [caseId], references: [id], onDelete: Cascade)` |  |
| taskId | String? |  |  |
| passed | Boolean? |  |  |
| score | Float? |  |  |
| output | String? | `@db.Text` |  |
| assertions | String | `@db.Text` | JSON: assertion results |
| judgeReason | String? | `@db.Text` |  |
| durationMs | Int? |  |  |
| createdAt | DateTime | `@default(now())` |  |

`@@index([runId])` · `@@index([caseId])`

### DriftReport

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| environmentId | String |  |  |
| environment | → Environment | `@relation(fields: [environmentId], references: [id], onDelete: Cascade)` |  |
| status | String | `@default("clean")` | clean \| drifted \| error |
| driftCount | Int | `@default(0)` |  |
| findings | String | `@db.Text` | JSON array of DriftFinding |
| scannedAt | DateTime | `@default(now())` |  |

`@@index([environmentId, scannedAt])`

### ScheduledTask

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| name | String |  |  |
| description | String? |  |  |
| agentId | String |  |  |
| agent | → Agent | `@relation("ScheduledTaskAgent", fields: [agentId], references: [id], onDelete: Cascade)` |  |
| cronExpr | String |  |  |
| taskTitle | String |  |  |
| taskDesc | String? | `@db.Text` |  |
| taskMeta | String? | `@db.Text` |  |
| enabled | Boolean | `@default(true)` |  |
| lastRunAt | DateTime? |  |  |
| nextRunAt | DateTime? |  |  |
| lastTaskId | String? |  |  |
| createdBy | String? |  | User.id of the owner; null = legacy row (admin-only to modify) |
| createdAt | DateTime | `@default(now())` |  |
| updatedAt | DateTime | `@updatedAt` |  |

`@@index([agentId])` · `@@index([nextRunAt, enabled])` · `@@index([createdBy])`

### WebhookTrigger

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| name | String |  |  |
| agentId | String |  |  |
| agent | → Agent | `@relation("WebhookTriggerAgent", fields: [agentId], references: [id], onDelete: Cascade)` |  |
| secret | String |  |  |
| source | String | `@default("custom")` | github \| prometheus \| custom |
| taskTitle | String |  |  |
| taskDesc | String? |  |  |
| enabled | Boolean | `@default(true)` |  |
| lastFiredAt | DateTime? |  |  |
| fireCount | Int | `@default(0)` |  |
| createdAt | DateTime | `@default(now())` |  |

`@@index([agentId])`

### WebhookDelivery

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| triggerId | String |  |  |
| deliveryId | String |  | X-GitHub-Delivery UUID or SHA256(triggerId+rawBody) |
| receivedAt | DateTime | `@default(now())` |  |

`@@unique([triggerId, deliveryId])` · `@@index([receivedAt])`

### JobRun

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| source | String |  | "schedule" \| "webhook" \| "system" |
| sourceId | String |  | ScheduledTask.id, WebhookTrigger.id, or system job key |
| sourceName | String |  |  |
| agentId | String? |  |  |
| taskId | String? |  |  |
| status | String | `@default("running")` | running \| completed \| failed |
| startedAt | DateTime | `@default(now())` |  |
| finishedAt | DateTime? |  |  |
| errorMessage | String? |  |  |

`@@index([source, startedAt])` · `@@index([sourceId, startedAt])` · `@@index([startedAt])`

### NotificationChannel

| Field | Type | Attributes | Notes |
|---|---|---|---|
| id | String | `@id @default(cuid())` |  |
| name | String |  |  |
| type | String |  | slack \| discord \| webhook |
| webhookUrl | String |  |  |
| events | String | `@default("[\\"task_completed\\",\\"task_failed\\"]")` | JSON array |
| agentFilter | String? |  | JSON array of agent IDs to filter on, null = all agents |
| enabled | Boolean | `@default(true)` |  |
| createdAt | DateTime | `@default(now())` |  |

## Enums

- **ContainmentStatus**: pending, approved, rejected

- **VulnStatus**: open, fixed, accepted, false_positive

- **InvestigationStatus**: open, active, suspended, resolved, closed

- **ResolutionType**: true_positive, false_positive, benign, inconclusive

- **TLP**: white, green, amber, red

- **ObservableCategory**: ipv4, ipv6, domain, url, file_hash_md5, file_hash_sha1, file_hash_sha256, mac_address, email, username, file_path, registry_key, mutex, asn

- **ObservableVerdict**: malicious, suspicious, benign, unknown

- **ObservableRole**: ioc, artifact, infrastructure
