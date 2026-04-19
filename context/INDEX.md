# ORION — Function-Level Context Graph

> Open this vault in Obsidian for graph view. `[[wikilinks]]` are graph edges.
> For Claude: read INDEX.md, find your task below, read only the listed notes.

## Task Presets

| Task | Read these notes |
|------|-----------------|
| Gateway startup / registration / credentials | [[gateway-call-graph]] → `start()`, `joinWithToken()` |
| Add or modify a gateway tool (kubectl/docker/talos/shell) | [[gateway-tools]] |
| Add a new builtin tool type or execType | [[gateway-call-graph]] → `runTool()` + [[gateway-tools]] |
| ArgoCD or Ingress sync behavior | [[gateway-call-graph]] → `ArgoCDWatcher` / `IngressWatcher` |
| Task execution / agent runner selection | [[web-call-graph]] → `runTask()` + `createRunner()` |
| Watcher agents / directive parsing | [[web-call-graph]] → `runWatchers()` + `executeDirectives()` |
| Auth — login, session, SSO | [[web-call-graph]] → `authOptions`, `getCurrentUser()` |
| Database schema change | [[schema]] |
| Add a new API route | [[api-routes]] + [[schema]] (for DB model) |
| Chat streaming (Claude/Ollama/Gemini) | [[api-routes]] → `/api/chat/conversations/[id]/stream` |
| Kubernetes cache / SSE streaming | [[api-routes]] → `/api/k8s/stream` |
| Gateway client calls from web | [[web-call-graph]] → `GatewayClient` |
| Agent orchestrator timing / concurrency | [[web-call-graph]] → `pollOnce()`, `main()` |

## Notes in This Vault

- [[gateway-call-graph]] — Every function in the gateway: call graph, side effects, env vars
- [[gateway-tools]] — All 26 builtin tools: commands, schemas, timeouts, registration
- [[web-call-graph]] — Web lib functions: auth, db, agent runners, worker orchestrator
- [[api-routes]] — All API routes: HTTP method, DB ops, external calls, response shape
- [[schema]] — Prisma schema: all models, fields, foreign-key relationships

## Architecture in One Paragraph

**Gateway** (`apps/gateway/`): Express + MCP server. On boot it registers with ORION, loads tools, starts a 30s heartbeat, and (if cluster mode) polls ArgoCD and Ingress every 60s. Tool calls come in via MCP SSE or REST — builtin tools go to typed wrappers (`kubectl`, `docker`, `talosctl`, `sh`), custom tools go through `runTool()`. No DB — stateless except for credential file.

**Web** (`apps/web/`): Next.js 14 App Router. API routes are the backend. A separate **worker process** (`worker.ts`) polls DB every 15s for pending tasks, picks them up (max 3 concurrent), and runs them through an **agent runner** (Claude Code SDK, Ollama, OpenAI, or dispatcher). Runners stream `AgentEvent`s; the worker stores each event as a `Message` in a `Conversation`. Watcher agents run every 60s, parse `---DIRECTIVES---` blocks from output, and assign tasks.
