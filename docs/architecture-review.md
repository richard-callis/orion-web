# ORION Architecture Review & Suggestions

> Architectural analysis of the ORION management plane, identifying strengths, concerns, and improvement opportunities.

---

## Executive Summary

ORION is a well-architected management plane with a clear separation between the control plane (Next.js app) and data plane (Gateway MCP servers). The GitOps-first approach with policy-based auto-merge is solid. However, several areas need attention before production deployment on the RPi management node.

---

## Strengths

### 1. Clear Architectural Separation

- **Control Plane** (orion-web): Next.js app managing state, users, policies, AI orchestration
- **Data Plane** (orion-gateway): Lightweight MCP servers deployed per environment
- **Communication**: REST + SSE, Bearer token auth
- **Heartbeat Pattern**: Gateways self-report status every 30s

### 2. Provider-Agnostic GitOps

The `GitProvider` interface abstracts Gitea/GitHub/GitLab:

```typescript
// lib/git-provider.ts
interface GitProvider {
  ensureRepo(opts): Promise<Repo>
  createBranch(owner, repo, branch, from): Promise<Branch>
  commitFiles(opts): Promise<void>
  createPR(opts): Promise<PR>
  mergePR(opts): Promise<void>
  // ...
}
```

This allows switching git providers without rewriting the GitOps loop.

### 3. Policy Engine Design

The policy engine (`lib/gitops-policy.ts`) is well-structured:

- **Default allowlist**: Scale, restart, patch/minor image updates, configmaps, resource limits
- **Review required**: New deployments, ingress, RBAC, secrets, network policies
- **Per-environment overrides**: `policyConfig` JSON field supports `reviewAll: true` for prod
- **Audit trail**: Every PR body includes AI reasoning + policy verdict

### 4. Gateway Architecture

The gateway (`apps/gateway`) is appropriately minimal:

- ~300 lines of TypeScript
- Exposes MCP protocol over SSE (`/mcp` endpoint)
- Also provides REST API for non-MCP clients (Ollama, Gemini)
- Built-in tools for k8s/docker operations
- ArgoCD watcher reports sync state to ORION

### 5. Setup Token Pattern

First-run setup uses a one-time token printed to Docker logs:

```typescript
// lib/setup-token.ts
const token = randomBytes(32).toString('hex')
console.log(`SETUP_TOKEN: ${token}`)  // bootstrap.sh greps for this
```

Simple, effective, no external auth dependency.

---

## Concerns & Suggestions

### 🔴 Critical

#### 1. No Kubeconfig Validation Before Bootstrap

**Issue**: `bootstrapCluster()` in `lib/cluster-bootstrap.ts` writes the kubeconfig to disk and runs `kubectl cluster-info`, but doesn't validate:
- Context exists and is accessible
- User has cluster-admin privileges (required for Gateway)
- ArgoCD namespace doesn't already exist with conflicting state

**Suggestion**: Add preflight checks:

```typescript
// lib/cluster-preflight.ts
export async function validateKubeconfig(kubeconfigBase64: string): Promise<{
  valid: boolean
  errors: string[]
  warnings: string[]
  currentUser: string
  contextName: string
  clusterName: string
}> {
  const errors: string[] = []
  const warnings: string[] = []
  
  // Write to temp file
  const tmpFile = writeKubeconfigToTemp(kubeconfigBase64)
  
  try {
    // Check context
    const contextResult = await runQuiet('kubectl', ['config', 'current-context'], { KUBECONFIG: tmpFile })
    if (!contextResult.ok) errors.push('Invalid kubeconfig: cannot read current context')
    
    // Check cluster connectivity
    const clusterInfo = await runQuiet('kubectl', ['cluster-info'], { KUBECONFIG: tmpFile })
    if (!clusterInfo.ok) errors.push('Cannot connect to cluster')
    
    // Check user has cluster-admin
    const rbacCheck = await runQuiet('kubectl', ['auth', 'can-i', 'deploy', 'pods', '--namespace', 'kube-system'], { KUBECONFIG: tmpFile })
    if (!rbacCheck.out.trim().includes('yes')) {
      errors.push('User does not have cluster-admin privileges (required for Gateway)')
    }
    
    // Check for existing ArgoCD installation
    const existingArgoCD = await runQuiet('kubectl', ['get', 'namespace', 'argocd', '--ignore-not-found'], { KUBECONFIG: tmpFile })
    if (existingArgoCD.ok && existingArgoCD.out.includes('argocd')) {
      warnings.push('ArgoCD namespace already exists — may conflict with bootstrap')
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings,
      currentUser: '', // Extract from kubectl config view
      contextName: contextResult.out.trim(),
      clusterName: '', // Extract from cluster-info
    }
  } finally {
    await rm(tmpFile)
  }
}
```

Then call this from `POST /api/environments/[id]/preflight` before allowing bootstrap.

---

#### 2. No Idempotency in Bootstrap

**Issue**: Running bootstrap twice will:
- Re-install ArgoCD (potentially losing state)
- Re-create the Gateway join token (breaking existing Gateway)
- Potentially corrupt the Git repo state

**Suggestion**: Add idempotency checks:

```typescript
// lib/cluster-bootstrap.ts
export async function bootstrapCluster(...): Promise<void> {
  // ... existing code ...
  
  try {
    // Check for existing ArgoCD
    const existingArgoCD = await runQuiet(
      'kubectl', ['get', 'deployment', 'argocd-server', '-n', 'argocd', '--ignore-not-found'],
      kenv
    )
    if (existingArgoCD.out.includes('argocd-server')) {
      emit({ type: 'step', message: 'ArgoCD already installed — skipping' })
      // Verify AppProject exists, create if missing
    } else {
      // Proceed with installation
    }
    
    // Gateway token should NOT be regenerated if Gateway already exists
    // Current code does check for this — good!
  }
}
```

---

#### 3. Gateway Token Stored in Plain Text

**Issue**: The gateway join token and permanent `gatewayToken` are stored in plain text in the database:

```prisma
model Environment {
  gatewayToken String?  // hashed token for gateway auth
}
```

**Suggestion**: Hash the gateway token using bcrypt or HMAC:

```typescript
// lib/auth.ts
export async function hashGatewayToken(token: string): Promise<string> {
  return await hash(token, 10)
}

export async function verifyGatewayToken(token: string, hashed: string): Promise<boolean> {
  return await compare(token, hashed)
}
```

Then in `apps/gateway/src/orion-client.ts`, store the hashed version and compare on auth.

---

### 🟡 High Priority

#### 4. No Rate Limiting on API Routes

**Issue**: The `/api/gitops/propose` endpoint has no rate limiting. A compromised session could spam PRs.

**Suggestion**: Add simple in-memory rate limiting:

```typescript
// lib/rate-limit.ts
import { LRUCache } from 'lru-cache'

const rateLimitCache = new LRUCache<string, number>({ max: 1000, ttl: 60_000 })

export function checkRateLimit(key: string, maxRequests: number = 10): boolean {
  const count = rateLimitCache.get(key) ?? 0
  if (count >= maxRequests) return false
  rateLimitCache.set(key, count + 1)
  return true
}
```

Apply to `/api/gitops/propose`, `/api/agents/spawn`, etc.

---

#### 5. Tool Execution Timeout Too Short

**Issue**: `tool-runner.ts` has a 30-second timeout for shell tool execution:

```typescript
const { stdout, stderr } = await exec('sh', ['-c', interpolated], { timeout: 30_000 })
```

This is insufficient for:
- `helm upgrade` operations
- Large `kubectl apply` with many resources
- Network operations (nmap scans, etc.)

**Suggestion**: Make timeout configurable per tool:

```prisma
model McpTool {
  // ...
  timeoutSecs Int?  // Default 30, override per tool
}
```

```typescript
// tool-runner.ts
const timeout = (tool.execConfig?.timeoutSecs ?? 30) * 1000
const { stdout, stderr } = await exec('sh', ['-c', interpolated], { timeout })
```

---

#### 6. No Error Recovery in GitOps Loop

**Issue**: If `proposeChange()` fails mid-flight (e.g., branch created but PR creation fails), the branch is left orphaned.

**Suggestion**: Wrap in try/catch with cleanup:

```typescript
export async function proposeChangeWithProvider(...): Promise<GitOpsChangeResult> {
  const branch = `${opts.branchPrefix ?? 'orion/auto'}/${slug}-${Date.now()}`
  
  try {
    await provider.createBranch(opts.owner, opts.repo, branch, 'main')
    await provider.commitFiles(...)
    const pr = await provider.createPR(...)
    // ...
    return { /* result */ }
  } catch (error) {
    // Clean up branch on failure
    try {
      await provider.deleteBranch(opts.owner, opts.repo, branch)
    } catch {
      // Non-fatal
    }
    throw error
  }
}
```

---

### 🟢 Medium Priority

#### 7. ArgoCD Watcher Polling Inefficient

**Issue**: The ArgoCD watcher polls `kubectl get applications -n argocd` every 60s regardless of whether ArgoCD is installed:

```typescript
// argocd-watcher.ts
private async poll() {
  const result = await execAsync('kubectl get applications -n argocd -o json 2>/dev/null')
  // Silently skips if ArgoCD not installed
}
```

**Suggestion**: Track ArgoCD availability state and adjust polling:

```typescript
export class ArgoCDWatcher {
  private argocdAvailable = false
  
  private async poll() {
    if (!this.argocdAvailable) {
      const check = await execAsync('kubectl get namespace argocd --ignore-not-found 2>/dev/null')
      if (check.stdout.includes('argocd')) {
        this.argocdAvailable = true
        console.log('[argocd-watcher] ArgoCD detected, starting full polling')
      } else {
        return  // Skip until ArgoCD appears
      }
    }
    // ... rest of polling logic
  }
}
```

---

#### 8. No Webhook Secret Rotation

**Issue**: The Gitea webhook secret is generated once during bootstrap and never rotated:

```typescript
// cluster-bootstrap.ts
const webhookSecret = randomBytes(32).toString('hex')
await provider.ensureWebhook(..., webhookUrl, webhookSecret)
```

**Suggestion**: Store the secret in the Environment record and support rotation:

```prisma
model Environment {
  // ...
  webhookSecret String?  // HMAC secret for webhook verification
}
```

Add `POST /api/environments/[id]/rotate-webhook` endpoint.

---

#### 9. Gateway Heartbeat Doesn't Detect Stale State

**Issue**: If a Gateway process hangs (stops heartbeating) but the pod remains running, ORION marks it as disconnected after ~30s. However, if the node dies entirely, Kubernetes may take minutes to detect and restart the pod.

**Suggestion**: Add a "last known good" timestamp and alert threshold:

```prisma
model Environment {
  // ...
  lastHeartbeat DateTime?  // When we last received a heartbeat
  degradedAt DateTime?     // When we first noticed missed heartbeats
}
```

In the heartbeat handler:

```typescript
// api/environments/[id]/route.ts
export async function PUT(req: NextRequest, { params }: {
  params: { id: string }
}) {
  const env = await prisma.environment.findUnique({ where: { id: params.id } })
  const now = new Date()
  const lastHeartbeat = env?.lastHeartbeat
  const missedHeartbeats = lastHeartbeat ? (now.getTime() - lastHeartbeat.getTime()) / 1000 / 30 : 0
  
  await prisma.environment.update({
    where: { id: params.id },
    data: {
      lastHeartbeat: now,
      status: missedHeartbeats > 2 ? 'degraded' : 'connected',
      degradedAt: missedHeartbeats > 2 && !env?.degradedAt ? now : null,
    },
  })
}
```

---

## Architectural Decisions to Revisit

### 10. Why Not Use ArgoCD Apps-of-Apps Pattern?

**Current approach**: ORION bootstraps ArgoCD with a single root Application that recurses through the Git repo.

**Alternative**: Use Apps-of-Apps pattern where each namespace/service is a separate Application resource.

**Pros of current approach**:
- Simpler bootstrap
- Fewer ArgoCD resources to manage

**Cons of current approach**:
- No per-application sync windows
- Harder to delegate ownership (can't give team access to just their app)
- Rollback is all-or-nothing

**Recommendation**: Current approach is fine for a homelab. Revisit if multi-team usage emerges.

---

### 11. Why Not Use OPA/Gatekeeper for Policy?

**Current approach**: Policy evaluated in ORION before PR creation.

**Alternative**: Use OPA/Gatekeeper to enforce policies at admission time.

**Pros of current approach**:
- Policy visible in PR (user sees why change was auto-merged or blocked)
- No additional infrastructure
- Fast feedback (policy checked before PR, not after)

**Cons of current approach**:
- Bypassed if someone edits Git repo directly
- No enforcement if ArgoCD syncs from non-ORION branch

**Recommendation**: Current approach is appropriate. Add a note in docs that direct Git edits bypass policy.

---

## Code Quality Observations

### Good Patterns

1. **TypeScript everywhere** — No `.js` files, proper type definitions
2. **Error boundaries** — `GiteaError` class with status codes
3. **SSE for streaming** — Bootstrap progress streamed via Server-Sent Events
4. **Idempotent setup token** — `ensureSetupToken()` checks before creating

### Areas for Improvement

1. **Inconsistent error handling** — Some routes throw, some return 400, some return 500
2. **No request validation** — Zod or similar would help validate API inputs
3. **Magic strings** — Operation types, gateway types scattered as string literals

---

## Recommendations Summary

### Before RPi Deployment

| Priority | Issue | Effort |
|----------|-------|--------|
| 🔴 | Add kubeconfig preflight validation | 2h |
| 🔴 | Add bootstrap idempotency | 1h |
| 🟡 | Increase tool timeout configurability | 30m |
| 🟡 | Add GitOps loop error recovery | 1h |

### Before Production Use

| Priority | Issue | Effort |
|----------|-------|--------|
| 🔴 | Hash gateway tokens | 1h |
| 🟡 | Add rate limiting | 1h |
| 🟡 | Add webhook secret rotation | 1h |
| 🟢 | Improve ArgoCD watcher efficiency | 30m |

### Nice to Have

- Gateway heartbeat stale state detection
- Request validation with Zod
- Centralized error handling middleware
- Structured logging (pino/winston)

---

## Final Thoughts

ORION is a solid architecture for a homelab management plane. The GitOps-first approach with policy-based auto-merge is the right choice. The Gateway pattern for extending tools per environment is elegant.

The main risks are:
1. **Bootstrap not idempotent** — Could corrupt state on retry
2. **No kubeconfig validation** — User may register unusable clusters
3. **Gateway tokens unhashed** — Security concern if DB is compromised

Address the 🔴 items before deploying to the RPi, then iterate based on real usage.

---

*Generated: 2026-04-16*
*Reviewer: Claude Code Architectural Analysis*
