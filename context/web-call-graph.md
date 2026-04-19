# Web Call Graph

> Files: `apps/web/src/lib/`, `apps/web/src/worker.ts`
> See also: [[api-routes]] for HTTP layer, [[schema]] for DB models

## Core Library Functions

### `lib/db.ts` — Prisma Singleton

```
export prisma (PrismaClient)
  └─ Global singleton — all DB queries go through this
  └─ Never create new PrismaClient() elsewhere
  └─ Called by: auth.ts, worker.ts, every agent runner, every API route
```

---

### `lib/auth.ts` — Authentication

```
authOptions (NextAuthOptions)
  │
  ├─ CredentialsProvider.authorize(credentials)
  │    ├─ prisma.user.findUnique({ where: { username } })
  │    ├─ bcryptjs.compare(password, passwordHash)         ← pure JS, ARM64 safe
  │    ├─ prisma.user.update({ lastSeen: new Date() })
  │    └─ returns { id, username, email, name, role }
  │
  ├─ jwt callback(token, user)
  │    ├─ on sign-in: set token.{id, username, role}
  │    └─ on refresh: prisma.user.findUnique(id)  → verify still active
  │
  └─ session callback(session, token)
       └─ copies token.{id, username, role} → session.user

getCurrentUser()                              → AppUser | null
  ├─ getServerSession(authOptions)            ← JWT cookie lookup
  ├─ if SSO headerMode:
  │    ├─ prisma.oIDCProvider.findFirst()
  │    └─ prisma.user.upsert()               ← auto-create SSO users
  └─ returns AppUser or null

requireAdmin()                                → AppUser (throws if not admin)
  └─ getCurrentUser() → throws "Unauthorized" if null or role != 'admin'
```

**DB models touched**: `User`, `OIDCProvider`

---

### `lib/agent-runner/` — Runner System

#### `index.ts` — Router

```
createRunner(modelId: string) → AgentRunner
  ├─ 'claude' | 'claude:*'  → claudeRunner
  ├─ 'ollama:*' | 'ext:*'  → dispatcherRunner
  └─ default                → claudeRunner
```

#### `claude-runner.ts`

```
claudeRunner.run(ctx: TaskRunContext)  → AsyncGenerator<AgentEvent>
  │
  ├─ getPrompt('system.task-execution')   → fetch system prompt template from DB
  ├─ interpolate(template, taskVars)      → substitute title, description, plan, notes
  ├─ @anthropic-ai/claude-code .query()  ← Claude Code SDK
  │    allowedTools: [Bash(kubectl get/describe/logs/top/rollout/scale:*)]
  │
  └─ yields:
       text       → model output chunks
       tool_call  → when Claude calls a tool
       tool_result → tool execution result
       done       → completion
       error      → on exception
```

#### `dispatcher-runner.ts`

```
dispatcherRunner.run(ctx)  → AsyncGenerator<AgentEvent>
  │
  ├─ if modelId starts with 'ext:':
  │    prisma.externalModel.findUnique(extId)
  │    → route to claudeRunner | ollamaRunner | openaiRunner based on provider
  │
  ├─ 'ollama:*' → ollamaRunner.run(ctx)
  ├─ 'claude:*' → claudeRunner.run(ctx)
  └─ default    → claudeRunner.run(ctx)
```

#### `ollama-runner.ts`

```
ollamaRunner.run(ctx)  → AsyncGenerator<AgentEvent>
  │
  ├─ resolveOllamaConfig(modelId)
  │    └─ prisma.externalModel.findUnique/findFirst()
  │         → { baseUrl, timeoutSecs }
  │
  ├─ if ctx.gateway:
  │    new GatewayClient(ctx.gateway.url, ctx.gateway.token)
  │    tools = gateway.listTools()         → GET /tools
  │
  └─ TOOL LOOP (max 20 turns):
       POST fetch(${ollamaBaseUrl}/api/chat, { messages, tools })
       if tool_calls in response:
         for each tool_call:
           yield tool_call event
           result = gateway.executeTool(name, args)   → POST /tools/execute
           yield tool_result event
           append to messages
         continue loop
       else:
         yield text event
         break
       yield done event
```

#### `openai-runner.ts` — same pattern as ollamaRunner

```
openaiRunner.run(ctx)
  ├─ resolveOpenAIConfig(modelId)
  │    └─ prisma.externalModel.findUnique()
  │         → { baseUrl, apiKey, modelId, timeoutSecs }
  └─ POST fetch(${baseUrl}/v1/chat/completions, ...)
       same 20-turn tool loop as ollamaRunner
```

#### `gateway-client.ts`

```
class GatewayClient(url, token)
  │
  ├─ listTools()        → GET ${url}/tools  (Bearer token)
  │    returns: GatewayTool[]
  │
  └─ executeTool(name, args)   → POST ${url}/tools/execute (Bearer token)
       body: { name, arguments: args }
       returns: result string
```

---

### `worker.ts` — Task Orchestrator (separate process)

#### Background Loops

```
main()
  ├─ pollOnce()                            ← immediate on startup
  ├─ setInterval(pollOnce, 15_000ms)       ← task polling loop
  ├─ setInterval(runWatchers, 60_000ms)    ← watcher agents loop
  └─ setInterval(syncGitOpsPRs, 60_000ms) ← GitOps PR sync loop
```

#### `pollOnce()` — Pick Up Pending Tasks

```
pollOnce()
  ├─ if runningTasks.size >= MAX_CONCURRENT (3): return
  ├─ prisma.task.findMany({
  │    where: { status: 'pending', assignedAgent: { not: null } },
  │    orderBy: { priority: 'desc' },
  │    take: MAX_CONCURRENT - runningTasks.size
  │  })
  └─ for each task: runTask(id)   ← async, not awaited
```

#### `runTask(taskId)` — Execute One Task

```
runTask(taskId)
  │
  ├─ prisma.task.findUnique({                 ← load task + agent + environment
  │    include: { agent: { include: { environments: { include: { environment } } } } }
  │  })
  │
  ├─ prisma.note.findMany({ where: { type: 'llm-context' } })   ← inject wiki context
  │
  ├─ prisma.task.update({ status: 'running' })
  ├─ prisma.conversation.create()             ← create conversation for output
  ├─ logTaskEvent(taskId, 'start', ...)
  ├─ postToFeed(agentId, ...)
  │
  ├─ createRunner(modelId)                    → AgentRunner
  │
  ├─ runner.run(ctx)  ← ASYNC GENERATOR LOOP
  │    for await (event of runner.run(ctx)):
  │      'text'        → prisma.message.create(role: 'assistant')
  │      'tool_call'   → logTaskEvent + prisma.message.create
  │      'tool_result' → logTaskEvent + prisma.message.create(role: 'user')
  │      'error'       → throw
  │
  ├─ prisma.task.update({ status: 'done' })
  ├─ prisma.claudeInvocation.create()         ← store token usage stats
  └─ on error: prisma.task.update({ status: 'failed' })

runningTasks: Set<string>   ← add taskId on start, delete on done/failed
```

**DB models touched**: `Task`, `Agent`, `AgentEnvironment`, `Environment`, `Note`, `Conversation`, `Message`, `TaskEvent`, `AgentMessage`, `ClaudeInvocation`

#### `runWatchers()` — Persistent Monitoring Agents

```
runWatchers()
  │
  ├─ prisma.agent.findMany({ where: { metadata: { persistent: true } } })
  │
  └─ for each watcher agent:
       if watcherLastRun[id] + watchIntervalMin * 60s > now: skip
       │
       ├─ buildSystemSnapshot()
       │    ├─ prisma.task.findMany({ where: { status: { in: ['pending','running','failed'] } } })
       │    ├─ prisma.agent.findMany()
       │    └─ prisma.taskEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 50 })
       │         → returns markdown summary string
       │
       ├─ prisma.note.findMany({ where: { type: 'llm-context' } })
       ├─ createRunner(modelId)
       ├─ runner.run(ctx with snapshot + notes in prompt)
       ├─ collect full output string
       ├─ executeDirectives(agentId, output)
       │    └─ parse ---DIRECTIVES--- JSON block
       │         for each assign directive:
       │           prisma.task.update({ assignedAgent: targetId })
       │           postToFeed() notification
       └─ postToFeed(agentId, output)
```

#### `logTaskEvent()` and `postToFeed()`

```
logTaskEvent(taskId, eventType, content, agentId?)
  └─ prisma.taskEvent.create({ taskId, eventType, content, agentId })

postToFeed(agentId, content, taskId?)
  └─ prisma.agentMessage.create({ agentId, channel: 'agent-feed', content, taskId })
```

#### `syncGitOpsPRs()`

```
syncGitOpsPRs()
  ├─ prisma.gitOpsPR.findMany({ where: { status: 'open' } })
  ├─ getGitProvider()   ← dynamic import
  ├─ provider.isHealthy()
  ├─ provider.getPR(prNumber)   ← fetch from git host
  └─ prisma.gitOpsPR.update({ status: merged | closed })
```

## Key Rules When Modifying Web

> **Task execution path**: `pollOnce() → runTask() → createRunner() → runner.run()`. Touch runTask() for task lifecycle, createRunner() for routing, the specific runner file for model-specific behavior.
>
> **Adding a new runner**: Implement `AgentRunner` interface (has `run(ctx): AsyncGenerator<AgentEvent>`), add a case to `createRunner()` in index.ts.
>
> **Worker is a separate process**: `src/worker.ts` is not part of Next.js. If it's not running, tasks will never execute. Check it independently.
>
> **llm-context Notes**: Notes with `type: 'llm-context'` are injected into every task's system prompt automatically. This is how the knowledge base affects agent behavior.
>
> **Watcher directive format**: Watcher agents output `---DIRECTIVES---\n{"assign":[{"taskId":"...","agentId":"..."}]}\n---END---` — any JSON outside that block is ignored by executeDirectives().
>
> **bcryptjs not bcrypt**: Password hashing uses `bcryptjs` (pure JS). Do NOT switch to native `bcrypt` — breaks on ARM64/RPi builds.
>
> **Gateway credentials in TaskRunContext**: `ctx.gateway.url` and `ctx.gateway.token` come from the Agent's linked Environment record. If a task's agent has no environment linked, gateway tools won't be available.
