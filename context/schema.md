# Prisma Schema — Model Relationships

> File: `apps/web/prisma/schema.prisma`
> Referenced by: [[web-call-graph]], [[api-routes]]

## Relationship Map

```
User ─────────────────── Task (assignedUserId)
  │                       │
  ├─ Session              ├─ Feature → Epic
  └─ EnvironmentUserTier  ├─ Agent (assignedAgent)
                          └─ TaskEvent

Agent ────────────────── AgentEnvironment ←→ Environment
  │                                              │
  ├─ AgentMessage                                ├─ McpTool → ToolGroup
  ├─ Task                                        ├─ GitOpsPR
  ├─ AgentGroupMember → AgentGroup               ├─ EnvironmentJoinToken
  └─ ToolAgentRestriction → McpTool              ├─ IngressPoint → IngressRoute
                                                 │               → IngressMiddleware
Conversation ─────────── Message                 ├─ Domain → DnsRecord
  │                                              └─ CorednsDomain
  ├─ ClaudeInvocation
  └─ Memory
```

## Models Reference

### Identity & Auth

| Model | Key Fields | Purpose |
|-------|-----------|---------|
| **User** | id, username, email, role (admin/user), passwordHash, provider, externalId, active, lastSeen | Local or SSO user |
| **Session** | sessionToken, userId, expires | NextAuth session (JWT strategy — rarely used directly) |
| **OIDCProvider** | name, enabled, issuerUrl, headerMode, groupMapping | SSO config (one row) |

### Agents & Tasks

| Model | Key Fields | Purpose |
|-------|-----------|---------|
| **Agent** | id, name, type (claude/ollama/human/custom), role, status, lastSeen, metadata (JSON) | AI or human agent |
| **Task** | id, title, description, plan, status (pending/running/done/failed), priority (1-10), assignedAgent (→Agent.id), assignedUserId, featureId | Unit of work |
| **TaskEvent** | id, taskId, eventType, content, agentId | Execution log for a task |
| **Feature** | id, epicId, title, description, plan, status | Feature in an epic |
| **Epic** | id, title, description, plan, status | Work grouping |
| **Bug** | id, title, severity, status, area, reportedBy, assignedUserId | Bug report |

### Environments & Tools

| Model | Key Fields | Purpose |
|-------|-----------|---------|
| **Environment** | id, name, type, gatewayUrl, gatewayToken, status, gitProvider, gitOwner, gitRepo, argoCdUrl, policyConfig, kubeconfig | Cluster or Docker environment |
| **AgentEnvironment** | agentId, environmentId | Many-to-many: agents ↔ environments |
| **McpTool** | id, environmentId, name, description, inputSchema (JSON), execType (builtin/shell/http), execConfig (JSON), enabled, builtIn | Tool definition |
| **ToolGroup** | id, name, environmentId, minimumTier | Access-control grouping of tools |
| **ToolGroupTool** | toolGroupId, toolId | Many-to-many: tools ↔ groups |
| **AgentGroup** | id, name | Grouping of agents |
| **AgentGroupMember** | agentGroupId, agentId | Many-to-many: agents ↔ groups |
| **AgentGroupToolAccess** | agentGroupId, toolGroupId | Agents in group can use tools in group |
| **ToolAgentRestriction** | toolId, agentId | Allowlist: only these agents can use this tool |
| **EnvironmentJoinToken** | id, token, environmentId, expiresAt, usedAt, fingerprint | One-time join token for gateway registration |
| **EnvironmentUserTier** | userId, environmentId, tier | User permission tier per environment |

### Conversations & Messages

| Model | Key Fields | Purpose |
|-------|-----------|---------|
| **Conversation** | id, title, metadata (JSON: initialContext, agentChat, ollamaModel, etc.), archivedAt | Chat or task execution session |
| **Message** | id, conversationId, role (user/assistant/tool_result/system), content, model, inputTokens, outputTokens, metadata | One message in a conversation |
| **ClaudeInvocation** | id, conversationId, prompt, toolsUsed, tokensUsed, durationMs, success | LLM invocation stats |
| **Memory** | id, conversationId, key, value, context | Persistent K-V facts stored during a conversation |
| **AgentMessage** | id, agentId, channel, content, messageType, threadId, metadata | Feed message from/about an agent |

### Networking & DNS

| Model | Key Fields | Purpose |
|-------|-----------|---------|
| **Domain** | id, name, type, coreDnsEnvironmentId, coreDnsIp | DNS domain |
| **DnsRecord** | id, domainId, ip, hostnames, enabled | A record |
| **IngressPoint** | id, domainId, environmentId, name, type, ip, port, certManager, clusterIssuer | Ingress entry point config |
| **IngressRoute** | id, ingressPointId, host, paths, tls, middlewares | HTTP route |
| **IngressMiddleware** | id, ingressPointId, name, type, config | Traefik middleware |

### GitOps

| Model | Key Fields | Purpose |
|-------|-----------|---------|
| **GitOpsPR** | id, environmentId, prNumber, title, operation, decision, status, prUrl, branch, mergedAt | Tracks a GitOps proposal PR |

### Tool Approval Workflow

| Model | Key Fields | Purpose |
|-------|-----------|---------|
| **ToolApprovalRequest** | id, conversationId, userId, environmentId, toolName, toolArgs, reason, status, approvedBy | Pending tool approval |
| **ToolExecutionGrant** | id, userId, environmentId, toolName, expiresAt, usedAt | One-time grant after approval |

### Config & Reference

| Model | Key Fields | Purpose |
|-------|-----------|---------|
| **ExternalModel** | id, name, provider, baseUrl, apiKey, modelId, enabled, timeoutSecs | External LLM (OpenAI, Ollama, Anthropic) |
| **SystemSetting** | key, value | Global settings (key-value) |
| **SystemPrompt** | key, name, category, content, variables | Reusable LLM prompt templates |
| **Note** | id, title, content, folder, pinned, type (note/wiki/runbook/llm-context), tags | Knowledge base — `llm-context` notes injected into tasks |
| **AuditLog** | id, userId, action, target, detail | Admin audit trail |
| **BackgroundJob** | id, type, title, status, logs, environmentId | Long-running async job |

## Critical Relationships for Common Tasks

### "I need to change what context agents get"
→ `Note` where `type = 'llm-context'` — these are auto-injected in `runTask()` and `runWatchers()`

### "I need to change how a task is assigned"
→ `Task.assignedAgent` → `Agent.id` | `Task.status` = pending → picked up by `pollOnce()`

### "I need to understand agent ↔ environment linkage"
→ `AgentEnvironment` join table — an agent can access multiple environments; task context uses the agent's first linked environment

### "I need to add a field to the agent's config"
→ `Agent.metadata` is a JSON field — arbitrary config lives there (e.g., `persistent`, `watchIntervalMin`)

### "I need to trace a conversation to its task"
→ `Conversation.metadata.taskId` (stored in metadata JSON when created by `runTask()`)

### "I need to add a new tool permission tier"
→ `ToolGroup.minimumTier` + `EnvironmentUserTier.tier` — tier number comparison controls access

## Schema Change Checklist

1. Edit `prisma/schema.prisma`
2. Run: `npx prisma migrate dev --name <description>`
3. Run: `npx prisma generate`
4. Update any API routes that query the affected model
5. Update TypeScript types if you added fields to interfaces in `lib/`
