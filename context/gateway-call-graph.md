# Gateway Call Graph

> File: `apps/gateway/src/`
> Depends on: [[gateway-tools]] for builtin tool details

## Module-Level Boot Sequence

```
index.ts (module load)
  │
  ├─ loadPersistedCredentials()        ← reads GATEWAY_CREDS_FILE from disk
  │    └─ readFileSync + JSON.parse
  │
  ├─ registerBuiltins(tools[])         ← populates BUILTIN_REGISTRY map
  │    └─ Called up to 4× based on GATEWAY_TYPE:
  │         'cluster'   → kubernetes, talos
  │         'docker'    → docker
  │         'localhost' → kubernetes, talos, docker, localhost
  │         ENABLE_DOCKER=true + 'cluster' → also docker
  │
  └─ if !WAITING_FOR_SETUP → start()
```

## start() — Full Dependency Tree

```
start()
  │
  ├─ if JOIN_TOKEN set:
  │    joinWithToken(token)
  │      ├─ fetch POST /api/environments/join    → ORION API
  │      ├─ persistCredentials()
  │      │    └─ execFileAsync('kubectl patch secret ...')   ← K8s API
  │      └─ saveCredentialsToFile()
  │           └─ writeFileSync(GATEWAY_CREDS_FILE)
  │
  ├─ new OrionClient({ orionUrl, environmentId, gatewayToken, ... })
  │
  ├─ orion.register()                  → PUT /api/environments/{id}
  ├─ orion.fetchTools()                → GET /api/environments/{id}/tools
  │    └─ returns McpToolConfig[]  →  populates activeTools
  │
  ├─ orion.startHeartbeat(callback, 30_000ms)
  │    └─ setInterval:
  │         fetchTools() → if tools changed → callback(newTools) → updates activeTools
  │
  ├─ if GATEWAY_TYPE = 'cluster':
  │    ├─ new ArgoCDWatcher(orion.reportSyncStatus, 60_000ms)
  │    │    └─ start() → poll() immediately + setInterval
  │    │         poll():
  │    │           execAsync('kubectl get applications -n argocd -o json')
  │    │           → parseApp(item) for each
  │    │           → if changed: orion.reportSyncStatus(apps)
  │    │                         └─ POST /api/environments/{id}/sync-status
  │    │
  │    └─ new IngressWatcher(orion.reportIngresses, 60_000ms)
  │         └─ start() → poll() immediately + setInterval
  │               poll():
  │                 execAsync('kubectl get ingress -A -o json')
  │                 → if changed: orion.reportIngresses(rules)
  │                               └─ POST /api/environments/{id}/ingress/sync
  │
  └─ app.listen(PORT)
```

## MCP Request Handlers

```
ListToolsRequestSchema handler
  └─ returns activeTools[]     ← no external calls

CallToolRequestSchema handler
  ├─ find tool in activeTools by name
  ├─ if tool.builtIn && BUILTIN_REGISTRY[name]:
  │    └─ BUILTIN_REGISTRY[name].execute(args)    → see [[gateway-tools]]
  └─ else:
       └─ runTool(tool, args)
```

## runTool() — Custom Tool Execution

```
runTool(tool: McpToolConfig, args: {})
  │
  ├─ case 'shell':
  │    ├─ ensurePackages(tool.requiredPackages)
  │    │    ├─ exec('sh -c "which {binary}"')   ← check existence
  │    │    └─ if missing: exec('sh -c "apk add {pkg}"')   ⚠️ mutates container
  │    ├─ interpolate args into tool.command template
  │    └─ exec('sh', ['-c', interpolatedCommand])
  │
  ├─ case 'http':
  │    ├─ interpolate args into tool.url template
  │    └─ fetch(url, { method, body })
  │
  └─ case 'builtin':
       └─ throws — builtins handled before reaching runTool()
```

## Express REST Handlers

```
GET  /health          → returns { status, environmentId, toolCount, gatewayType }
GET  /tools           → requireAuth → returns activeTools[]
POST /tools/execute   → requireAuth → BUILTIN_REGISTRY[name].execute() or runTool()
GET  /mcp             → new SSEServerTransport() → server.connect(transport)
POST /mcp/message     → SSE message handler
```

## OrionClient Methods

| Method | HTTP Call | Called By | Frequency |
|--------|-----------|-----------|-----------|
| `register()` | PUT /api/environments/{id} | start() | once on boot |
| `fetchTools()` | GET /api/environments/{id}/tools | start() + heartbeat | every 30s |
| `startHeartbeat(cb)` | — setInterval | start() | — |
| `stopHeartbeat()` | — clearInterval | SIGTERM | — |
| `reportSyncStatus(apps)` | POST /api/environments/{id}/sync-status | ArgoCDWatcher.poll() | when argocd changes |
| `reportIngresses(rules)` | POST /api/environments/{id}/ingress/sync | IngressWatcher.poll() | when ingresses change |
| `disconnect()` | PUT /api/environments/{id} (disconnected) | SIGTERM | — |

## SIGTERM Handler

```
SIGTERM
  ├─ argoCdWatcher.stop()    → clearInterval
  ├─ ingressWatcher.stop()   → clearInterval
  ├─ orion.stopHeartbeat()   → clearInterval
  └─ process.exit(0)
```

## Global State (index.ts module scope)

| Variable | Type | Set By | Read By |
|----------|------|--------|---------|
| `ENVIRONMENT_ID` | string | loadPersistedCredentials / joinWithToken | OrionClient constructor, requireAuth |
| `GATEWAY_TOKEN` | string | loadPersistedCredentials / joinWithToken | OrionClient headers(), requireAuth |
| `MACHINE_ID` | string | randomUUID() on first boot | joinWithToken |
| `activeTools` | McpToolConfig[] | fetchTools() + heartbeat | MCP handlers, REST /tools |
| `BUILTIN_REGISTRY` | Record<string, BuiltinTool> | registerBuiltins() | CallTool handler |
| `orion` | OrionClient | start() | ArgoCDWatcher/IngressWatcher callbacks |
| `argoCdWatcher` | ArgoCDWatcher | start() | SIGTERM handler |
| `ingressWatcher` | IngressWatcher | start() | SIGTERM handler |

## Key Rules When Modifying Gateway

> **Adding a new background watcher**: Follow the ArgoCDWatcher/IngressWatcher pattern — constructor takes `(onChanged callback, intervalMs)`, start/stop toggle the interval, poll() runs the logic and calls onChanged if state changed. Wire up in start() and SIGTERM.
>
> **Adding a new custom execType**: Add a new `case` in `runTool()` in `tool-runner.ts`. Don't touch index.ts.
>
> **Credential bootstrap**: JOIN_TOKEN → joinWithToken() → persistCredentials() (K8s Secret) + saveCredentialsToFile(). On restart: loadPersistedCredentials() reads the file. If you change the credential schema, update both persist and load.
>
> **GATEWAY_TYPE controls tool availability**: Adding a new tool set requires updating the `registerBuiltins()` block in index.ts. The type is set by env var at container launch.
>
> **apk add side effect**: `ensurePackages()` installs packages into the running container. This is intentional but ephemeral — packages are lost on restart.
