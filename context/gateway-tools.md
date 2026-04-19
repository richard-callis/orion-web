# Gateway Builtin Tools

> File: `apps/gateway/src/builtin-tools/`
> Referenced by: [[gateway-call-graph]]

## Registration by GATEWAY_TYPE

| Tool Set | File | GATEWAY_TYPE that activates it |
|----------|------|-------------------------------|
| kubernetesTools | kubernetes.ts | cluster, localhost |
| talosTools | talos.ts | cluster, localhost |
| dockerTools | docker.ts | docker, localhost, cluster+ENABLE_DOCKER |
| localhostTools | localhost.ts | localhost only |

## Shared Helper Functions

Each file has a local wrapper that calls `execFile` via promisify:

| Helper | File | Default Timeout | Wraps |
|--------|------|-----------------|-------|
| `kubectl(args, timeoutMs)` | kubernetes.ts | 30s | execFile('kubectl') |
| `helm(args)` | kubernetes.ts | 300s | execFile('helm') |
| `docker(args)` | docker.ts | 30s | execFile('docker') |
| `talosctl(args, configB64, timeoutMs)` | talos.ts | 60s | writes /tmp config, execFile('talosctl'), cleanup |
| `sh(cmd, args, timeoutMs)` | localhost.ts | 30s | execFile(cmd) |

**Temp file pattern** (talos + kubectl_apply_manifest):
```
writeFileSync('/tmp/orion-{name}-{Date.now()}.yaml', content)
try { execFile(...) }
finally { unlinkSync(tmpFile) }   // always cleaned up
```

## All 26 Builtin Tools

### Kubernetes Tools (`kubernetes.ts`) — 12 tools

| Tool | Command | Key Input Fields | Timeout | Notes |
|------|---------|-----------------|---------|-------|
| `kubectl_get_pods` | `kubectl get pods -n {ns} -l {selector} -o wide` | namespace?, selector? | 30s | |
| `kubectl_get_nodes` | `kubectl get nodes [-o wide]` | wide? | 30s | |
| `kubectl_logs` | `kubectl logs {pod} -n {ns} --tail={n} [-c {c}] [--previous]` | pod, namespace, container?, tail?=100, previous? | 30s | |
| `kubectl_describe` | `kubectl describe {resource} {name} [-n {ns}]` | resource, name, namespace? | 30s | |
| `kubectl_get` | `kubectl get {resource} [{name}] [-n {ns}] [-o {fmt}]` | resource, name?, namespace?, output? | 30s | output: wide/json/yaml/name |
| `kubectl_rollout_restart` | `kubectl rollout restart {kind}/{name} -n {ns}` | kind, name, namespace | 30s | kind: deployment/statefulset/daemonset |
| `kubectl_top_pods` | `kubectl top pods [-n {ns}]` | namespace? | 30s | |
| `kubectl_apply_url` | `kubectl apply -f {url} [-n {ns}]` | url, namespace? | 120s | |
| `kubectl_apply_manifest` | write YAML to /tmp → `kubectl apply -f /tmp/...` | manifest (YAML string) | 60s | temp file, cleaned up |
| `kubectl_rollout_status` | `kubectl rollout status {kind}/{name} -n {ns} --timeout={t}` | kind, name, namespace, timeout?="120s" | timeout+5s | |
| `kubectl_wait_nodes_ready` | `kubectl wait --for=condition=Ready nodes --all --timeout={t}` | timeout?="300s" | timeout+10s | |
| `helm_upgrade_install` | `helm upgrade --install {rel} {chart} --repo {r} -n {ns} [--set key=val ...] [--wait] [--timeout {t}]` | release, chart, repo?, namespace, createNamespace?, values?, wait?=true, timeout?="120s" | 300s | iterates values obj as --set flags |

### Docker Tools (`docker.ts`) — 6 tools

| Tool | Command | Key Input Fields | Timeout | Notes |
|------|---------|-----------------|---------|-------|
| `docker_ps` | `docker ps [--all]` | all? | 30s | |
| `docker_logs` | `docker logs {c} [--tail {n}] [--since {t}]` | container, tail?, since? | 30s | |
| `docker_stats` | `docker stats --no-stream [{c}]` | container? | 30s | snapshot only |
| `docker_inspect` | `docker inspect {c}` | container | 30s | |
| `docker_exec` | `docker exec {c} sh -c {cmd}` | container, command | 30s | |
| `docker_run` | `docker rm -f {name}` then `docker run {flags} {image} {args}` | image, name?, restart?, ports?[], volumes?[], env?{}, args?[], detach? | 30s | idempotent: force-removes first |

### Talos Tools (`talos.ts`) — 5 tools

> All tools require `talosConfig` (base64-encoded talosconfig YAML) and `nodeIp`.

| Tool | Command | Key Input Fields | Timeout | Notes |
|------|---------|-----------------|---------|-------|
| `talos_get_version` | `talosctl version` | nodeIp, talosConfig | 60s | |
| `talos_get_extensions` | `talosctl get extensions -o json` | nodeIp, talosConfig | 60s | |
| `talos_patch_machineconfig` | `talosctl patch machineconfig --patch {json}` | nodeIp, talosConfig, patch (JSON string) | 60s | |
| `talos_upgrade` | `talosctl upgrade --image {img} [--preserve] --wait` | nodeIp, talosConfig, installerImage, preserve?=true | **600s** | destructive — reboots node |
| `talos_reboot` | `talosctl reboot --wait` | nodeIp, talosConfig | **300s** | destructive — reboots node |

### Localhost Tools (`localhost.ts`) — 3 tools

> Only available on GATEWAY_TYPE=localhost. Most powerful — can run arbitrary commands.

| Tool | Command | Key Input Fields | Timeout | Notes |
|------|---------|-----------------|---------|-------|
| `shell_exec` | `sh -c {command}` | command, timeout_secs?=30 | up to 120s | ⚠️ arbitrary execution |
| `file_read` | `readFileSync(path)` | path, max_bytes?=65536 | — | capped at 1MB |
| `system_info` | `uptime`, `free -h`, `df -h` in parallel | none | 30s each | uses Promise.allSettled |

## Error Handling Pattern

All tools follow this pattern:
```typescript
execute: async (args) => {
  try {
    const result = await kubectl(['get', 'pods', ...])
    return result  // stdout string
  } catch (err) {
    return `Error: ${err.message}\n${err.stderr || ''}`  // never throws
  }
}
```

Errors are returned as strings, never thrown. The MCP handler wraps uncaught exceptions in `isError: true` responses.

## Adding a New Builtin Tool

1. Add tool object to the appropriate file's exported array:
   ```typescript
   {
     name: 'tool_name',          // snake_case
     description: 'What it does',
     inputSchema: {
       type: 'object',
       properties: { field: { type: 'string', description: '...' } },
       required: ['field']
     },
     execute: async (args: Record<string, unknown>) => {
       const field = args.field as string
       return kubectl(['...', field])
     }
   }
   ```
2. No changes to index.ts needed — the array is registered wholesale.
3. If adding to a new file, register the new array in the `registerBuiltins()` block in index.ts.
