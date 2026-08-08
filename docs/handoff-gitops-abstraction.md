# Handoff: GitOps Abstraction Layer

**For:** Qwen3 27B  
**Reviewer:** Claude (will review output and spawn a fixer if needed)  
**Branch:** create `feat/gitops-abstraction` from `main`  
**Working directory:** `/home/rkhalis/orion-work` (do NOT write to `/opt/orion`)

---

## What You Are Building

Orion manages two environment types: Kubernetes clusters and Docker hosts. Right now, ArgoCD (GitOps sync visibility) only works for K8s. The goal is **identical sync status visibility for both** — same UI, same API shape, different underlying watcher.

This work also makes Orion deployable in air-gapped networks (no public internet) while still supporting remote gateways on separate networks via an optional reverse proxy.

Five things need to happen:

1. **Add `DockerComposeWatcher`** to the gateway — mirrors `ArgoCDWatcher` exactly, uses Docker socket instead of `kubectl get applications`
2. **Add ArgoCD bootstrap logic** to the cluster gateway boot — ArgoCD deploys INTO the cluster (not on the host), the gateway bootstraps it on first boot
3. **Remove ArgoCD from `deploy/docker-compose.yml`** — it no longer belongs on the host
4. **Fix air-gap regressions** — several places in `apps/web/src` fall back to `NEXTAUTH_URL` (the public Cloudflare URL) for internal service communication; fix them to use `ORION_CALLBACK_URL` with the correct fallback chain
5. **Reverse proxy integration** — the existing IngressPoint bootstrap already deploys Traefik to Docker hosts and K8s clusters; add a `set-as-orion-proxy` endpoint to link a bootstrapped IngressPoint to Orion's public URL, which then drives what gets baked into gateway manifests

---

## Architecture Decisions (Already Made — Do Not Revisit)

- `ArgoCDApp` is the shared sync status shape for both paths. `DockerComposeWatcher` maps Docker container state onto `ArgoCDApp` fields. No new types.
- `GATEWAY_TYPE=cluster` → ArgoCD bootstrap + `ArgoCDWatcher` (existing, unchanged)
- `GATEWAY_TYPE=docker` → `DockerComposeWatcher` (new)
- `GATEWAY_TYPE=localhost` → `DockerComposeWatcher` (localhost has Docker socket)
- ArgoCD runs **inside the cluster** as a K8s deployment, bootstrapped by the cluster gateway on first boot
- `GITEA_CLUSTER_URL` is baked into the gateway manifest at join time — not fetched at runtime. The manifest generation route resolves which URL to use based on the reverse proxy config (see below).
- The `sync-status` API and `reportSyncStatus()` method are **unchanged** — both watchers call the same endpoint with the same `ArgoCDApp[]` shape
- `NEXTAUTH_URL` is a **browser-only** URL (public domain, behind Cloudflare). It must never be used for service-to-service or cluster-to-host communication. `ORION_CALLBACK_URL` is the correct variable for that.

### Reverse Proxy Model

There are two configuration moments:

**1. During the setup wizard (bootstrap time):**
The only option available is deploying Traefik on the management node — no cluster is registered yet so there is nothing else to deploy to.

| Wizard answer | `reverse-proxy.type` | Effect |
|---|---|---|
| Yes, set it up now | `'docker'` | Traefik Docker profile activated on host |
| No / skip | `'none'` | Local network only until configured later |
| I have my own | `'external'` | User supplies public URL, no bootstrap |

**2. Post-wizard inside Orion (Ingress page):**
The Ingress page already allows users to create IngressPoints and bootstrap Traefik into any environment (Docker or K8s). The existing `POST /api/ingress/points/:id/bootstrap` route handles the actual Traefik deployment — no new bootstrap code is needed.

The only new capability needed is **marking a bootstrapped IngressPoint as Orion's public proxy** via `POST /api/ingress/points/:id/set-as-orion-proxy`. This stores two SystemSettings:
- `reverse-proxy.public-url` — derived from the IngressPoint's domain
- `reverse-proxy.ingress-point-id` — the IngressPoint ID (for reference/display)

Once set, gateway manifests use the public URL. To remove it, call the endpoint with `{ clear: true }` which deletes both settings.

**What these settings drive:**
- **Gateway manifest generation** (`join/[token]/manifest/route.ts`): if `reverse-proxy.public-url` is set, use it as `ORION_URL` in the manifest; otherwise use `http://<MANAGEMENT_IP>:3000`
- **`GITEA_CLUSTER_URL` in manifest**: if `reverse-proxy.public-url` is set, use `GITEA_PUBLIC_URL` env var; otherwise use `http://<MANAGEMENT_IP>:3002`
- **Local gateways always use management IP** regardless of reverse proxy setting — only remote gateways use the public URL

---

## Files to Create

### 1. `apps/gateway/src/docker-compose-watcher.ts` (NEW)

Mirror the structure of `apps/gateway/src/argocd-watcher.ts` exactly.

```typescript
/**
 * Docker Compose Sync Watcher
 *
 * Polls Docker container state every 60s.
 * Maps running containers onto the ArgoCDApp shape so the same
 * sync-status API and UI work for Docker environments.
 *
 * Requires: /var/run/docker.sock mounted (already present on docker/localhost gateways).
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import type { ArgoCDApp } from './argocd-watcher.js'

const execAsync = promisify(exec)

type SyncReportFn = (apps: ArgoCDApp[]) => Promise<void>

export class DockerComposeWatcher {
  private timer?: ReturnType<typeof setInterval>
  private lastState: Map<string, string> = new Map()

  constructor(
    private readonly onChanged: SyncReportFn,
    private readonly intervalMs = 60_000,
  ) {}

  start() {
    this.poll().catch(err => console.error('[docker-watcher] Initial poll failed:', err))
    this.timer = setInterval(() => {
      this.poll().catch(err => console.error('[docker-watcher] Poll failed:', err))
    }, this.intervalMs)
    console.log(`[docker-watcher] Watching Docker containers (interval: ${this.intervalMs / 1000}s)`)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  private async poll() {
    // ...implementation below...
  }
}
```

**`poll()` implementation:**

Run `docker ps -a --format json` (outputs NDJSON — one JSON object per line, one per container). Parse with:
```typescript
const lines = stdout.trim().split('\n').filter(Boolean)
const containers = lines.map(line => JSON.parse(line))
```

**Field mapping — use `State` (not `Status`) for classification:**

`docker ps --format json` exposes two distinct fields:
- **`State`** — lowercase lifecycle string: `running`, `exited`, `restarting`, `created`, `paused`, `dead`
- **`Status`** — human-readable string: `"Up 2 hours"`, `"Exited (1) 5 minutes ago"`, `"Up 3 minutes (health: starting)"`, etc.

Use `State` for `syncStatus` and `healthStatus` classification. Use `Status` only for the `message` field and for detecting `"health: starting"` (present only when a Docker healthcheck is defined).

| `ArgoCDApp` field | Docker source |
|---|---|
| `name` | `Names` field, strip leading `/` |
| `namespace` | `"docker"` (constant) |
| `project` | `Labels["com.docker.compose.project"]`, fallback `"docker"` |
| `syncStatus` | `"Synced"` if `State === "running"`, `"OutOfSync"` if `State === "exited"` or `State === "restarting"`, else `"Unknown"` |
| `healthStatus` | `"Healthy"` if `State === "running"` and `Status` does not contain `"health: starting"`, `"Progressing"` if `State === "running"` and `Status` contains `"health: starting"`, `"Degraded"` if `State === "exited"` or `State === "restarting"` or `State === "dead"`, else `"Unknown"` |
| `revision` | `Image` field (tag/name — no digest available from `docker ps`) |
| `message` | `Status` string |
| `reconciledAt` | `new Date().toISOString()` |

**Change detection:** Same pattern as `ArgoCDWatcher` — snapshot is `${syncStatus}:${healthStatus}:${revision}`, compare against `lastState` map keyed by container name. Call `onChanged(allApps)` (full list, not just changed) when any entry differs.

**Known limitation — removed containers:** If a container is removed entirely (not just stopped), its name disappears from `docker ps -a`. The stale entry remains in `lastState` but will never trigger a new report. This is acceptable for the first version — the same limitation exists in `ArgoCDWatcher` for deleted ArgoCD Applications.

**Error handling:** Wrap the entire `poll()` body in try/catch. If Docker socket is unavailable, log and return silently — same as `ArgoCDWatcher` does for missing `kubectl`.

---

### 2. `apps/gateway/src/argocd-bootstrap.ts` (NEW)

Called once at cluster gateway startup before `ArgoCDWatcher` starts. Checks if ArgoCD is installed and bootstraps it if not. Designed to be idempotent — safe to call on every restart.

```typescript
/**
 * ArgoCD Bootstrap
 *
 * Runs at cluster gateway startup. Installs ArgoCD into the cluster if not
 * already present, then registers the git repo configured in Orion.
 *
 * Designed to be idempotent — safe to call on every restart.
 */

export interface GitProviderInfo {
  type: 'gitea-bundled' | 'gitea' | 'github' | 'gitlab'
  /** Repo clone URL base — already adjusted for cluster reachability by the Orion API.
   *  May be empty string if git provider is not fully configured; treat empty as "skip". */
  url: string
  token: string   // API token / PAT
  org: string     // default org/user namespace
}

export async function bootstrapArgoCD(
  orionUrl: string,
  environmentId: string,
  gatewayToken: string,
): Promise<void>
```

**Steps inside `bootstrapArgoCD`:**

1. **Check if ArgoCD namespace exists:**
   ```bash
   kubectl get namespace argocd
   ```
   If exit code 0 → ArgoCD already installed, skip to step 4.

2. **Install ArgoCD:**
   ```bash
   kubectl create namespace argocd
   kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
   ```

3. **Wait for ArgoCD to be ready** (timeout 120s):
   ```bash
   kubectl wait --for=condition=available deployment/argocd-server -n argocd --timeout=120s
   ```

4. **Fetch git provider config from Orion:**
   ```
   GET {orionUrl}/api/environments/{environmentId}/git-provider
   Authorization: Bearer {gatewayToken}
   ```
   Response shape: `{ type, url, token, org }` — the `url` field is already adjusted for cluster reachability by the API (see route below). If this returns a non-200, or if `url` is empty string, log a warning and return — ArgoCD will work without a registered repo.

5. **Check if repo is already registered:**
   ```bash
   kubectl get secret -n argocd -l argocd.argoproj.io/secret-type=repository -o json
   ```
   Parse the JSON. If any secret's `data.url` (base64-decoded) matches `${url}/${org}` → skip registration.

6. **Register the repo as an ArgoCD repository Secret.**

   Construct `repoUrl = ${apiResponse.url}/${apiResponse.org}` for all provider types — do not re-derive per type; the API already returned the correct URL for the cluster to reach.

   Username convention: `github` type uses `x-access-token`; all others use `orion`.

   Apply via `kubectl apply -f -` with stdin:
   ```yaml
   apiVersion: v1
   kind: Secret
   metadata:
     name: orion-git-repo
     namespace: argocd
     labels:
       argocd.argoproj.io/secret-type: repository
   stringData:
     type: git
     url: <repoUrl>
     password: <token>
     username: <"x-access-token" for github, "orion" for all others>
   ```

**Error handling:** Wrap each step in its own try/catch. Log errors but do not throw — a failed ArgoCD bootstrap must not prevent the gateway from starting. `ArgoCDWatcher` already handles the case where ArgoCD isn't ready (it silently skips).

---

## Files to Modify

### 3. `apps/gateway/src/index.ts`

**Two changes only. Do not touch anything else in this file. Do not modify sibling files.**

**Change A — Add imports** after the existing `ArgoCDWatcher` import at line 60:
```typescript
import { DockerComposeWatcher } from './docker-compose-watcher.js'
import { bootstrapArgoCD } from './argocd-bootstrap.js'
```

**Change B — Add module-level declaration** alongside the existing watcher declarations at line 309. The current block is:
```typescript
let orion: OrionClient
let argoCdWatcher:  ArgoCDWatcher  | undefined
let ingressWatcher: IngressWatcher | undefined
let hooksEngine:  HooksEngine  | undefined
let skillLoader:  SkillLoader | undefined
```
Add one line after `ingressWatcher`:
```typescript
let dockerWatcher: DockerComposeWatcher | undefined
```

**Change C — Replace the watcher block in `start()`**, lines 532–542. Current code:
```typescript
  if (GATEWAY_TYPE === 'cluster') {
    argoCdWatcher = new ArgoCDWatcher(
      async (apps) => { await orion.reportSyncStatus(apps) },
    )
    argoCdWatcher.start()

    ingressWatcher = new IngressWatcher(
      async (ingresses) => { await orion.reportIngresses(ingresses) },
    )
    ingressWatcher.start()
  }
```
Replace with:
```typescript
  if (GATEWAY_TYPE === 'cluster') {
    // Bootstrap ArgoCD into the cluster (idempotent — safe on every restart)
    bootstrapArgoCD(ORION_URL, ENVIRONMENT_ID, GATEWAY_TOKEN).catch(err =>
      console.error('[gateway] ArgoCD bootstrap failed (non-fatal):', err instanceof Error ? err.message : String(err))
    )

    argoCdWatcher = new ArgoCDWatcher(
      async (apps) => { await orion.reportSyncStatus(apps) },
    )
    argoCdWatcher.start()

    ingressWatcher = new IngressWatcher(
      async (ingresses) => { await orion.reportIngresses(ingresses) },
    )
    ingressWatcher.start()
  }

  if (GATEWAY_TYPE === 'docker' || GATEWAY_TYPE === 'localhost') {
    dockerWatcher = new DockerComposeWatcher(
      async (apps) => { await orion.reportSyncStatus(apps) },
    )
    dockerWatcher.start()
  }
```

**Change D — Update the SIGTERM handler** at lines 554–561. Current handler:
```typescript
process.on('SIGTERM', () => {
  console.log('[gateway] Shutting down…')
  argoCdWatcher?.stop()
  ingressWatcher?.stop()
  orion.stopHeartbeat()
  hooksEngine?.stop()
  process.exit(0)
})
```
Add `dockerWatcher?.stop()` alongside the other stops:
```typescript
process.on('SIGTERM', () => {
  console.log('[gateway] Shutting down…')
  argoCdWatcher?.stop()
  ingressWatcher?.stop()
  dockerWatcher?.stop()
  orion.stopHeartbeat()
  hooksEngine?.stop()
  process.exit(0)
})
```

---

### 4. `apps/web/src/app/api/environments/[id]/git-provider/route.ts` (NEW FILE)

Create this file. Do not modify any sibling routes under `apps/web/src/app/api/environments/[id]/`.

Auth pattern is copied exactly from `apps/web/src/app/api/environments/[id]/sync-status/route.ts` lines 28–35.

**Design principle — air-gap first:** This endpoint is called by a cluster gateway pod. Traffic must stay on the private network. Do NOT use `GITEA_PUBLIC_URL`, `NEXTAUTH_URL`, or any public domain here — those are browser-only URLs behind Cloudflare. The correct internal URL follows the same pattern as `ORION_CALLBACK_URL`:

| Provider | Cluster-reachable URL |
|---|---|
| `gitea-bundled` | `http://<MANAGEMENT_IP>:3002` — Gitea's host-exposed port, same network as `ORION_CALLBACK_URL` |
| `gitea` (external) | `config.url` — the user typed this in during wizard; it's already the right URL |
| `github` | `https://github.com` — public, but GitHub is always reachable; if truly air-gapped use a GitHub Enterprise URL stored in `config.url` |
| `gitlab` | `config.url` — user-supplied, already correct |

```typescript
/**
 * GET /api/environments/:id/git-provider
 *
 * Returns the git provider config for a cluster gateway to use when
 * bootstrapping ArgoCD repo registration.
 *
 * Auth: Bearer gatewayToken (same as heartbeat/sync-status).
 *
 * Air-gap design: returns cluster-reachable URLs only (management IP / internal
 * hostnames). Never returns public/Cloudflare URLs — those are browser-only.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getGitProviderConfig } from '@/lib/git-provider'

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = req.headers.get('authorization')
  const env = await prisma.environment.findUnique({ where: { id: params.id } })
  if (!env) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const expectedToken = env.gatewayToken
  if (expectedToken && auth !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const config = await getGitProviderConfig()
  if (!config) {
    return NextResponse.json({ error: 'Git provider not configured' }, { status: 404 })
  }

  // Resolve the cluster-reachable URL for the git provider.
  // For gitea-bundled: use http://<MANAGEMENT_IP>:3002 so traffic stays on the
  // private network and works in air-gapped deployments. This mirrors how
  // ORION_CALLBACK_URL uses http://<MANAGEMENT_IP>:3000 for gateway→Orion traffic.
  // Port 3002 is the host-exposed port for the bundled Gitea container (docker-compose.yml).
  let url: string
  if (config.type === 'gitea-bundled') {
    const managementIp = process.env.MANAGEMENT_IP
    if (!managementIp) {
      return NextResponse.json(
        { error: 'MANAGEMENT_IP not set — cannot derive cluster-reachable Gitea URL' },
        { status: 500 },
      )
    }
    url = `http://${managementIp}:3002`
  } else {
    // External providers: the user supplied a URL during wizard setup.
    // config.url is optional for github (uses api.github.com implicitly) but the
    // bootstrap only needs the base clone URL, not the API URL — use the org pattern.
    url = config.url ?? (config.type === 'github' ? 'https://github.com' : '')
  }

  if (!url) {
    return NextResponse.json(
      { error: 'No cluster-reachable git URL available' },
      { status: 404 },
    )
  }

  return NextResponse.json({
    type: config.type,
    url,
    token: config.token,
    org: config.org,
  })
}
```

**Note on `GitProviderConfig` field optionality:** `url` and `publicUrl` are both optional (`url?`, `publicUrl?`) in the interface. For `gitea-bundled`, `url` is typically absent in the stored config (the internal Docker hostname `http://gitea:3000` is derived at runtime, not stored). For `github`, `url` is also absent. The route handles both cases above.

---

### 5. `deploy/docker-compose.yml`

Remove the four ArgoCD services. They no longer belong on the host — ArgoCD now lives in the cluster.

**Remove these complete service blocks:**
- `argocd-server` (comment + service)
- `argocd-repo-server`
- `argocd-application-controller`
- `argocd-redis`

**Remove these two entries from the `volumes:` block** at the bottom of the file:
- `argocd-server-data:`
- `argocd-redis-data:`

---

---

## Additional Files to Modify

### 6. `apps/web/src/app/api/environments/join/[token]/manifest/route.ts`

This route generates the K8s manifest that gets applied when a cluster gateway joins. It already resolves `ORION_URL` correctly using a fallback chain. Make two additions:

**Important — `SystemSetting.value` is typed `Json`, not `String`.**
Prisma returns `Prisma.JsonValue` for this column. Always narrow to `string` before using:
```typescript
function settingStr(setting: { value: Prisma.JsonValue } | null, fallback: string): string {
  return typeof setting?.value === 'string' ? setting.value : fallback
}
```
Use this helper for every `SystemSetting` read in this file.

**Addition A — Read reverse proxy SystemSetting:**

After the existing `orionUrl` resolution block (lines 27–33), add:

```typescript
  const proxyTypeSetting = await prisma.systemSetting.findUnique({ where: { key: 'reverse-proxy.type' } })
  const proxyUrlSetting  = await prisma.systemSetting.findUnique({ where: { key: 'reverse-proxy.public-url' } })
  const proxyPublicUrl   = settingStr(proxyUrlSetting, '')

  const remoteOrionUrl  = proxyPublicUrl || orionUrl
  const managementIp    = process.env.MANAGEMENT_IP ?? ''
  const giteaClusterUrl = proxyPublicUrl
    ? (process.env.GITEA_PUBLIC_URL ?? `http://${managementIp}:3002`)
    : `http://${managementIp}:3002`
```

**Addition B — Update the Secret and inject `GITEA_CLUSTER_URL`:**

`ORION_URL` in the manifest is sourced from a Kubernetes Secret (not an inline env var). The Secret is built at approximately line 149 as `stringData`:
```yaml
stringData:
  orion-url: "${orionUrl}"
```
Change `"${orionUrl}"` → `"${remoteOrionUrl}"` here.

Then, after the `ORION_URL` env var block in the Deployment (which uses `valueFrom.secretKeyRef`, around line 183–187), add `GITEA_CLUSTER_URL` as a new **inline** env var:
```yaml
            - name: GITEA_CLUSTER_URL
              value: "${giteaClusterUrl}"
```
Do not attempt to add it next to a `value:` on the `ORION_URL` block — that block uses `valueFrom`, not `value`.

---

### 7. Air-Gap Fixes — `apps/web/src/lib/cluster-bootstrap.ts`

**Problem:** Line 348 defines `ORION_URL` using `NEXTAUTH_URL` as the primary source — this is the public Cloudflare domain and is unreachable from inside a cluster in an air-gapped network.

```typescript
// CURRENT (line 348) — WRONG:
const ORION_URL = process.env.NEXTAUTH_URL ?? 'http://localhost:3000'
```

**Fix:** Replace with the same fallback chain used everywhere else:

```typescript
// FIXED:
const ORION_URL = (
  process.env.ORION_CALLBACK_URL ??
  (process.env.MANAGEMENT_IP ? `http://${process.env.MANAGEMENT_IP}:3000` : null) ??
  'http://localhost:3000'
).replace(/\/$/, '')
```

---

### 8. Air-Gap Fixes — `apps/web/src/lib/localhost-bootstrap.ts` and `apps/web/src/lib/docker-gateway.ts`

**Problem:** Both files include `process.env.NEXTAUTH_URL` in the `ORION_CALLBACK_URL` fallback chain. If `MANAGEMENT_IP` is not set and `NEXTAUTH_URL` is the public Cloudflare URL, internal service communication silently breaks in air-gapped deployments.

`localhost-bootstrap.ts` lines 27–32 (current):
```typescript
const ORION_CALLBACK_URL = (
  process.env.ORION_CALLBACK_URL ??
  (process.env.MANAGEMENT_IP ? `http://${process.env.MANAGEMENT_IP}:3000` : null) ??
  process.env.NEXTAUTH_URL ??       // ← remove this line
  'http://localhost:3000'
).replace(/\/$/, '')
```

`docker-gateway.ts` lines 19–24 — same pattern, same fix.

**Fix for both:** Remove the `process.env.NEXTAUTH_URL ??` line from the fallback chain. The final fallback `'http://localhost:3000'` is sufficient — if we reach it, it means neither `ORION_CALLBACK_URL` nor `MANAGEMENT_IP` is set, and a warning should be logged:

```typescript
const ORION_CALLBACK_URL = (
  process.env.ORION_CALLBACK_URL ??
  (process.env.MANAGEMENT_IP ? `http://${process.env.MANAGEMENT_IP}:3000` : null) ??
  'http://localhost:3000'
).replace(/\/$/, '')

if (!process.env.ORION_CALLBACK_URL && !process.env.MANAGEMENT_IP) {
  console.warn('[orion] WARNING: Neither ORION_CALLBACK_URL nor MANAGEMENT_IP is set. Gateway/webhook URLs will use localhost — this will break in container environments.')
}
```

---

### 9. Reverse Proxy Routes — Two Separate API Routes

#### 9a. Wizard step — `apps/web/src/app/api/setup/reverse-proxy/route.ts` (NEW FILE)

Called during the setup wizard. Only `'none'`, `'external'`, and `'docker'` are valid here — `'cluster'` is not available at wizard time because no environment is registered yet.

Follow the exact same pattern as `apps/web/src/app/api/setup/git-provider/route.ts` — auth via `requireWizardSession`, persist to `SystemSetting`, return `{ ok: true }`.

```typescript
/**
 * POST /api/setup/reverse-proxy
 *
 * Wizard step — configure reverse proxy on the management node.
 * Only 'none', 'external', and 'docker' are valid here.
 * 'cluster' (deploy into a managed environment) is a post-wizard action.
 *
 * Body shapes:
 *   { type: 'none' }
 *   { type: 'external', publicUrl: string }   — BYO proxy, validates reachability
 *   { type: 'docker',   publicUrl: string }   — Traefik on Docker host, bootstrap.sh activates --profile proxy
 *   { skip: true }                            — same as 'none'
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireWizardSession } from '@/lib/setup-guard'

export async function POST(req: NextRequest) {
  if (!await requireWizardSession(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json() as { type?: string; publicUrl?: string; skip?: boolean }

  if (body.skip) {
    await upsert('reverse-proxy.type', 'none')
    return NextResponse.json({ ok: true, skipped: true })
  }

  const { type, publicUrl } = body

  if (!type || !['none', 'external', 'docker'].includes(type)) {
    return NextResponse.json({ error: "type must be 'none', 'external', or 'docker'" }, { status: 400 })
  }

  if (type !== 'none' && !publicUrl) {
    return NextResponse.json({ error: 'publicUrl is required' }, { status: 400 })
  }

  // For 'external': validate the URL is reachable right now (proxy is already running).
  // For 'docker': skip validation — Traefik won't be running until bootstrap.sh restarts
  //   with --profile proxy. The stored publicUrl is unverified until then; the UI should
  //   surface a warning prompting the user to re-verify after bootstrap.sh runs.
  if (type === 'external' && publicUrl) {
    try {
      const res = await fetch(`${publicUrl.replace(/\/$/, '')}/api/health`, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) {
        return NextResponse.json({ error: `Public URL returned ${res.status} — check the URL and try again` }, { status: 502 })
      }
    } catch {
      return NextResponse.json({ error: 'Could not reach publicUrl — check URL and try again' }, { status: 502 })
    }
  }

  await upsert('reverse-proxy.type', type)
  if (publicUrl) await upsert('reverse-proxy.public-url', publicUrl.replace(/\/$/, ''))

  return NextResponse.json({ ok: true, type, publicUrl: publicUrl ?? null })
}

async function upsert(key: string, value: string) {
  await prisma.systemSetting.upsert({
    where: { key }, update: { value }, create: { key, value },
  })
}
```

#### 9b. Ingress page action — `apps/web/src/app/api/ingress/points/[id]/set-as-orion-proxy/route.ts` (NEW FILE)

**Context:** The existing `POST /api/ingress/points/:id/bootstrap` already deploys Traefik — to a Docker host via `docker_run`, or to a K8s cluster via MetalLB + cert-manager + Helm. No new bootstrap code is needed in the gateway or elsewhere. This endpoint simply marks an already-bootstrapped IngressPoint as Orion's public face.

Auth: `requireAdmin` — same pattern as `bootstrap/route.ts` in the same directory.

```typescript
/**
 * POST /api/ingress/points/:id/set-as-orion-proxy
 *
 * Marks a bootstrapped IngressPoint as Orion's reverse proxy.
 * Stores its public URL in SystemSettings so gateway manifests use it.
 *
 * Body:
 *   {}            — set this IngressPoint as the proxy
 *   { clear: true } — remove the proxy config (manifests revert to management IP)
 *
 * Stores:
 *   SystemSetting 'reverse-proxy.public-url'      = https://<domain>
 *   SystemSetting 'reverse-proxy.ingress-point-id' = <id>
 *
 * Clearing deletes both settings.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json() as { clear?: boolean }

  if (body.clear) {
    await prisma.systemSetting.deleteMany({
      where: { key: { in: ['reverse-proxy.public-url', 'reverse-proxy.ingress-point-id'] } },
    })
    return NextResponse.json({ ok: true, cleared: true })
  }

  const point = await prisma.ingressPoint.findUnique({
    where: { id: params.id },
    include: { domain: true },
  })
  if (!point) return NextResponse.json({ error: 'IngressPoint not found' }, { status: 404 })

  // point.domain.name is the apex domain (e.g. "khalisio.com").
  // The actual Orion hostname may be a subdomain (e.g. "orion.khalisio.com") configured
  // in the IngressRoute. For now we use the apex; the user can override publicUrl in .env.
  const publicUrl = `https://${point.domain.name}`

  await upsert('reverse-proxy.public-url', publicUrl)
  await upsert('reverse-proxy.ingress-point-id', params.id)

  return NextResponse.json({ ok: true, publicUrl })
}

async function upsert(key: string, value: string) {
  await prisma.systemSetting.upsert({
    where: { key }, update: { value }, create: { key, value },
  })
}
```

---

### 10. Docker Traefik Profile — `deploy/docker-compose.yml`

Add a Traefik service under `profiles: [proxy]`. The Traefik labels already on `orion` and `vault` services will be picked up automatically when this profile is active. This is used when the user bootstraps an IngressPoint on the management node during the wizard.

Add this service block after the `coredns` service:

```yaml
  # ── Traefik — reverse proxy (optional — activate with: docker compose --profile proxy up)
  # Only needed when exposing Orion to remote gateways on separate networks.
  # Activated by bootstrap.sh when REVERSE_PROXY_TYPE=docker is set in .env.
  traefik:
    profiles: [proxy]
    image: traefik:v3.0
    restart: unless-stopped
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
      - --entrypoints.web.http.redirections.entrypoint.to=websecure
      - --entrypoints.web.http.redirections.entrypoint.scheme=https
      - --certificatesresolvers.letsencrypt.acme.tlschallenge=true
      - --certificatesresolvers.letsencrypt.acme.email=${ACME_EMAIL:-admin@example.com}
      - --certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - traefik-letsencrypt:/letsencrypt
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 256M
```

Add `traefik-letsencrypt:` to the `volumes:` block.

Update `bootstrap.sh`: add `--profile proxy` to `PROFILE_FLAGS` when `REVERSE_PROXY_TYPE=docker`. Insert **after the `GIT_PROVIDER` block (lines 10–12) and before the `COMPOSE=` assignment on line 14** — `COMPOSE` is built from `PROFILE_FLAGS` at line 14, so the mutation must happen before that line:

```bash
# After the existing GIT_PROVIDER profile flag logic:
REVERSE_PROXY_TYPE="${REVERSE_PROXY_TYPE:-none}"
if [[ "$REVERSE_PROXY_TYPE" == "docker" ]]; then
  PROFILE_FLAGS="$PROFILE_FLAGS --profile proxy"
fi
```

---

## Key Patterns to Follow

### `ArgoCDWatcher` — the template
**File:** `apps/gateway/src/argocd-watcher.ts`

- Constructor: `(onChanged: SyncReportFn, intervalMs = 60_000)`
- `start()` calls `poll()` immediately, then sets interval
- `stop()` clears interval
- `poll()` is `private`, wraps entire body in try/catch, returns silently on error
- `lastState` is `Map<string, string>` — key = app name, value = snapshot string
- Sends **full app list** to `onChanged` on any change (not just changed items)
- `ArgoCDApp` interface lives here and is imported by `OrionClient` — **do not change it**

### `OrionClient.reportSyncStatus()`
**File:** `apps/gateway/src/orion-client.ts` lines 102–115

Accepts `ArgoCDApp[]`, POSTs `{ applications: apps }` to `/api/environments/{id}/sync-status`. **Unchanged.**

### Auth pattern for new API route
**File:** `apps/web/src/app/api/environments/[id]/sync-status/route.ts` lines 28–35 — copy verbatim.

### `getGitProviderConfig()`
**File:** `apps/web/src/lib/git-provider/index.ts`

Returns `GitProviderConfig | null`. Import path: `@/lib/git-provider`. `url` and `publicUrl` are optional fields — always guard with `??`.

---

## What NOT to Change

- `apps/gateway/src/argocd-watcher.ts` — do not modify
- `apps/gateway/src/orion-client.ts` — do not modify
- `apps/web/src/app/api/environments/[id]/sync-status/route.ts` — do not modify
- Any other file under `apps/web/src/app/api/environments/[id]/` — do not modify
- `apps/web/prisma/schema.prisma` — no schema changes needed
- Any existing test files

---

## Checklist Before Handing Back

**GitOps abstraction:**
- [ ] `apps/gateway/src/docker-compose-watcher.ts` created, compiles without errors
- [ ] `apps/gateway/src/argocd-bootstrap.ts` created with `bootstrapArgoCD` exported, compiles without errors
- [ ] `apps/gateway/src/index.ts` — only Changes A/B/C/D applied, nothing else touched

**Web API:**
- [ ] `apps/web/src/app/api/environments/[id]/git-provider/route.ts` created
- [ ] `apps/web/src/app/api/setup/reverse-proxy/route.ts` created (wizard — `none`/`external`/`docker` only)
- [ ] `apps/web/src/app/api/ingress/points/[id]/set-as-orion-proxy/route.ts` created (Ingress page — marks bootstrapped IngressPoint as Orion's proxy)
- [ ] `apps/web/src/app/api/environments/join/[token]/manifest/route.ts` — `GITEA_CLUSTER_URL` injected; `ORION_URL` uses `remoteOrionUrl` derived from `reverse-proxy.public-url` SystemSetting

**Air-gap fixes:**
- [ ] `apps/web/src/lib/cluster-bootstrap.ts` line 348 — `ORION_URL` uses `ORION_CALLBACK_URL` fallback chain, not `NEXTAUTH_URL`
- [ ] `apps/web/src/lib/localhost-bootstrap.ts` — `NEXTAUTH_URL` removed from fallback chain, warning added
- [ ] `apps/web/src/lib/docker-gateway.ts` — same fix as above

**Deploy:**
- [ ] `deploy/docker-compose.yml` — ArgoCD services and volumes removed; Traefik service added under `profiles: [proxy]`; `traefik-letsencrypt` volume added
- [ ] `deploy/bootstrap.sh` — `--profile proxy` added when `REVERSE_PROXY_TYPE=docker`

**Compile:**
- [ ] `tsc --noEmit` passes in `apps/gateway/` with no new errors
- [ ] `tsc --noEmit` passes in `apps/web/` with no new errors
- [ ] No changes outside the files listed above

---

## Scope Boundary

This task does NOT include:

- UI changes (wizard screens, sync status display) — backend only
- Changing how GitOpsPRs are created or merged
- Modifying ArgoCD Application definitions (what gets deployed)
- Any database migrations — `SystemSetting` is a key-value table, no schema change needed
- The `managed-env` deployment templates (separate concern)
- Cloudflare Tunnel or WireGuard VPN setup — out of scope for this iteration
