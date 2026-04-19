# API Routes — Dependency Map

> Files: `apps/web/src/app/api/`
> See also: [[schema]] for DB models, [[web-call-graph]] for lib functions

## Auth Status

**No route-level auth middleware is enforced.** Routes assume caller is trusted (internal app calls from the Next.js frontend). The session is checked at the page/layout level, not per-route.

## Route Reference

### `/api/agents`

| Method | Route | DB Ops | External | Returns |
|--------|-------|--------|----------|---------|
| GET | `/agents` | `agent.findMany()` | — | Agent[] |
| POST | `/agents` | `agent.create()` | — | Agent (201) |
| GET | `/agents/[id]` | `agent.findUnique()` + tasks (20) + messages (10) | — | Agent with relations |
| PUT | `/agents/[id]` | `agent.findUnique()` + `agent.update()` | — | Agent |
| DELETE | `/agents/[id]` | `task.updateMany(unassign)` + `agent.delete()` | — | 204 |
| POST | `/agents/[id]/chat` | `agent.findUnique()` + `conversation.create()` | — | Conversation + streamUrl hint (201) |
| GET | `/agents/messages` | `agentMessage.findMany()` | — | AgentMessage[] |
| POST | `/agents/messages` | `agentMessage.create()` | — | AgentMessage (201) |

### `/api/chat/conversations`

| Method | Route | DB Ops | External | Returns |
|--------|-------|--------|----------|---------|
| GET | `/chat/conversations` | `conversation.findMany()` (not archived, max 50) | — | Conversation[] |
| POST | `/chat/conversations` | `conversation.create()` | — | Conversation (201) |
| GET | `/chat/conversations/[id]` | `conversation.findUnique()` | — | Conversation |
| PATCH | `/chat/conversations/[id]` | `conversation.update()` | — | Conversation |
| DELETE | `/chat/conversations/[id]` | `conversation.update({ archivedAt })` | — | 204 |
| GET | `/chat/conversations/[id]/messages` | `message.findMany()` | — | Message[] |
| POST | `/chat/conversations/[id]/stream` | message.findMany (history) + message.create (×2) + claudeInvocation.create | Claude/Ollama/Gemini API | **SSE stream** |

#### `/api/chat/conversations/[id]/stream` Detail

```
POST → reads conversation.metadata to determine mode:

metadata.agentChat is set
  └─ streamAgentChat(agent, history, prompt)
       └─ lib/claude.ts → Claude Code SDK or Ollama depending on agent.llm

metadata.ollamaModel set
  └─ streamOllamaChat(model, history, prompt)
       └─ fetch(ollamaBaseUrl/api/chat)

metadata.geminiModel set
  └─ streamGeminiChat(model, history, prompt)
       └─ fetch(googleapis.com/generativelanguage...)

default
  └─ streamClaudeResponse(history, prompt, metadata)
       └─ @anthropic-ai/claude-code .query()

All modes:
  → createSSEStream()  (lib/sse.ts)
  → yield chunks as SSE events: { type: 'text'|'tool_call'|'tool_result'|'done'|'error' }
  → prisma.message.create (user prompt + assistant response)
  → prisma.claudeInvocation.create (stats)
```

### `/api/tasks`

| Method | Route | DB Ops | External | Returns |
|--------|-------|--------|----------|---------|
| GET | `/tasks` | `task.findMany()` with agent + feature includes | — | Task[] |
| POST | `/tasks` | `task.create()` | — | Task (201) |
| GET | `/tasks/[id]` | `task.findUnique()` + agent + feature + events | — | Task with relations |
| PUT | `/tasks/[id]` | `task.update()` | — | Task |
| DELETE | `/tasks/[id]` | `task.delete()` | — | 204 |

### `/api/features` and `/api/epics`

| Method | Route | DB Ops | External | Returns |
|--------|-------|--------|----------|---------|
| GET | `/features` | `feature.findMany()` with epic + task count | — | Feature[] |
| POST | `/features` | `feature.create()` | — | Feature (201) |
| GET/PUT/DELETE | `/features/[id]` | standard CRUD | — | Feature |
| POST | `/features/[id]/generate-tasks` | `feature.findUnique()` + `task.create()` (bulk) | Claude Code SDK | Task[] (201) |
| GET | `/epics` | `epic.findMany()` nested features + task counts | — | Epic[] |
| POST | `/epics` | `epic.create()` | — | Epic (201) |
| GET/PUT/DELETE | `/epics/[id]` | standard CRUD | — | Epic |

### `/api/k8s`

| Method | Route | DB Ops | External / Lib | Returns |
|--------|-------|--------|----------------|---------|
| GET | `/k8s/nodes` | — | `lib/k8s.ts getCache().nodes` | CachedNode[] |
| GET | `/k8s/pods` | — | `lib/k8s.ts getCache().pods` | CachedPod[] |
| GET | `/k8s/stream` | — | `lib/k8s.ts startWatchers() + addSseClient()` | **SSE stream** (pod/node events) |

#### `/api/k8s/stream` Detail

```
GET → long-lived SSE connection
  ├─ startWatchers()     ← starts K8s Watch on pods + nodes (if not already running)
  ├─ addSseClient(res)   ← registers this response to receive broadcasts
  ├─ sends 'init' event with current cache snapshot
  ├─ as K8s Watch events arrive → broadcast(event, data) to all SSE clients
  └─ on client disconnect → removeSseClient(res)

lib/k8s.ts internal state:
  cache: { pods: CachedPod[], nodes: CachedNode[], lastUpdated: Date }
  sseClients: Set<Response>
  watchers auto-reconnect every 5s on failure
```

### `/api/environments`

| Method | Route | DB Ops | External | Returns |
|--------|-------|--------|----------|---------|
| GET | `/environments` | `environment.findMany()` | — | Environment[] |
| POST | `/environments` | `environment.create()` | — | Environment (201) |
| GET/PUT/DELETE | `/environments/[id]` | standard CRUD | — | Environment |
| POST | `/environments/[id]/join-token` | `environmentJoinToken.create()` | — | Token |
| POST | `/environments/[id]/bootstrap` | various creates | gateway bootstrap calls | Bootstrap result |

### `/api/admin`

| Method | Route | DB Ops | Notes |
|--------|-------|--------|-------|
| GET | `/admin/users` | `user.findMany()` | |
| POST | `/admin/users` | `user.create()` with bcryptjs hash | |
| PUT/DELETE | `/admin/users/[id]` | `user.update/delete()` | |
| GET | `/admin/settings` | `systemSetting.findMany()` | |
| PUT | `/admin/settings` | `systemSetting.upsert()` | |
| GET/PUT | `/admin/system-prompts/[key]` | `systemPrompt.upsert()` | |
| GET | `/admin/audit-log` | `auditLog.findMany()` | |

### `/api/health`

```
GET /health
  ├─ prisma.$queryRaw('SELECT 1')         → db: true/false
  ├─ k8s.coreApi.listNamespace()          → k8s: true/false
  ├─ readFileSync('/claude-creds/.claude') → claude: true/false
  ├─ fetch(ollamaUrl/api/tags)            → ollama: true/false
  └─ for each ExternalModel (enabled):
       fetch(model.baseUrl/health or /api/tags) → externalModels[ext:id]: bool

Returns: { k8s, db, claude, ollama, externalModels: {} }
Status: 200 if k8s && db, else 503
```

### `/api/auth/[...nextauth]`

```
Handled by NextAuth.js using authOptions from lib/auth.ts
  ├─ GET  /api/auth/session   → current session
  ├─ POST /api/auth/signin    → CredentialsProvider.authorize()
  ├─ GET  /api/auth/signout   → clear session cookie
  └─ GET  /api/auth/csrf      → CSRF token
```

## Shared Lib Dependencies

```
lib/sse.ts
  └─ createSSEStream(res) → sets SSE headers, returns { send(event, data), close() }
  └─ Used by: /api/chat/conversations/[id]/stream, /api/k8s/stream

lib/claude.ts
  ├─ streamClaudeResponse(history, prompt, metadata)
  ├─ streamAgentChat(agent, history, prompt)
  ├─ streamOllamaChat(model, history, prompt)
  ├─ streamGeminiChat(model, history, prompt)
  └─ maybeGetSummarizedHistory(conversation) → summary string or full history
       └─ generateSummary() via Ollama (free) or Claude (fallback)

lib/k8s.ts
  ├─ startWatchers()       → start K8s Watch connections
  ├─ getCache()            → { pods, nodes, lastUpdated }
  ├─ addSseClient(res)
  └─ removeSseClient(res)
```

## Adding a New Route

1. Create `src/app/api/<resource>/route.ts`
2. Export named functions: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`
3. For DB access: import `prisma` from `@/lib/db`
4. For auth: import `getCurrentUser` or `requireAdmin` from `@/lib/auth`
5. For SSE: import `createSSEStream` from `@/lib/sse`
6. Return `NextResponse.json(data, { status: 200 })` or `new Response(stream)`
