/**
 * POST /api/ingress/points/:id/bootstrap-sso
 *
 * Bootstraps an identity provider (Authentik, Authelia, OAuth2 Proxy, Keycloak, or Custom OIDC)
 * into the associated environment.
 *
 * Falls back to local kubectl execution (via stored kubeconfig) if the gateway is unreachable.
 *
 * Returns { jobId } immediately — progress tracked via /api/jobs/[id].
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { startJob, type JobLogger } from '@/lib/job-runner'
import { GatewayClient } from '@/lib/agent-runner/gateway-client'
import { requireAdmin } from '@/lib/auth'
import { makeLocalGx } from '@/lib/local-exec'
import { getProvider, type ProviderConfig, type RenderContext } from '@/lib/provider-engine'

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const point = await prisma.ingressPoint.findUnique({
    where: { id: params.id },
    include: { environment: true },
  })
  if (!point) {
    return NextResponse.json({ error: 'IngressPoint not found' }, { status: 404 })
  }
  if (!point.environment) {
    return NextResponse.json({ error: 'IngressPoint has no associated environment' }, { status: 422 })
  }

  const env = point.environment
  const body = await _req.json().catch(() => ({}))
  const provider = String(body.provider ?? 'authentik')
  const hostname = String(body.hostname ?? '')
  const namespace = String(body.namespace ?? 'security')
  const clusterIssuer = String(body.clusterIssuer ?? 'letsencrypt-prod')
  const adminPassword = String(body.adminPassword ?? '')
  const oidcIssuerUrl = String(body.oidcIssuerUrl ?? '')
  const clientId = String(body.clientId ?? '')
  const clientSecret = String(body.clientSecret ?? '')
  const customIssuerCaSecret = String(body.customIssuerCaSecret ?? '')
  const databaseType = String(body.databaseType ?? 'sqlite')
  const redisHost = String(body.redisHost ?? '')

  if (!hostname) {
    return NextResponse.json({ error: 'Hostname is required' }, { status: 422 })
  }

  // Determine execution mode: gateway first, fallback to local kubeconfig
  const gwUrl = env.gatewayUrl
  const gwToken = env.gatewayToken
  const hasKubeconfig = Boolean(env.kubeconfig)

  let useGateway = false
  let useLocal = false

  if (gwUrl && gwToken) {
    // Try the gateway
    try {
      const res = await fetch(`${gwUrl}/tools/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gwToken}` },
        body: JSON.stringify({ name: 'kubectl_get_nodes', arguments: { wide: false } }),
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok) {
        useGateway = true
      }
    } catch {
      // Gateway unreachable
    }
  }

  if (!useGateway && hasKubeconfig) {
    useLocal = true
  }

  if (!useGateway && !useLocal) {
    if (gwUrl && !gwToken) {
      return NextResponse.json({ error: 'Gateway URL set but no gateway token' }, { status: 422 })
    }
    if (gwToken && !gwUrl) {
      return NextResponse.json({ error: 'Gateway token set but no gateway URL' }, { status: 422 })
    }
    if (gwUrl && gwToken) {
      return NextResponse.json({ error: `Gateway at ${gwUrl} is not reachable and no kubeconfig is stored. Deploy the gateway via the Environment settings page.` }, { status: 422 })
    }
    return NextResponse.json({ error: 'No gateway available and no kubeconfig stored. Deploy the gateway or upload a kubeconfig for this environment.' }, { status: 422 })
  }

  const jobId = await startJob(
    'bootstrap-sso',
    `Bootstrap SSO (${provider}) — ${hostname}`,
    { environmentId: env.id, metadata: { provider, hostname, namespace, useGateway, useLocal } },
    async log => {
      if (useGateway) {
        await log(`Using gateway at ${gwUrl} for cluster operations`)
        const gc = new GatewayClient(gwUrl!, gwToken!)
        await bootstrapProvider(gwExecFn(gc), log, { provider, hostname, namespace, clusterIssuer, adminPassword, oidcIssuerUrl, clientId, clientSecret, customIssuerCaSecret, databaseType, redisHost, isDocker: false })
      } else if (useLocal) {
        await log(`Using local kubectl (stored kubeconfig) for cluster operations`)
        await bootstrapProvider(makeLocalGx(env.kubeconfig!), log, { provider, hostname, namespace, clusterIssuer, adminPassword, oidcIssuerUrl, clientId, clientSecret, customIssuerCaSecret, databaseType, redisHost, isDocker: false })
      }
    },
  )

  return NextResponse.json({ jobId })
}

function gwExecFn(gc: GatewayClient) {
  return (tool: string, args: Record<string, unknown>) => gc.executeTool(tool, args)
}

// Check for and remove stale Helm releases from previous failed deployments
async function cleanupStaleHelmRelease(
  gx: (tool: string, args: Record<string, unknown>) => Promise<string>,
  log: JobLogger,
  cfg: { provider: string; hostname: string; namespace: string },
): Promise<void> {
  const releaseNames: Record<string, string> = {
    authentik: 'authentik',
    authelia: 'authelia',
    oauth2_proxy: 'oauth2-proxy',
    keycloak: 'keycloak',
    custom_oidc: 'oauth2-proxy',
  }
  const releaseName = releaseNames[cfg.provider]
  if (!releaseName) return

  // Check if the release exists
  try {
    const result = await gx('helm_list', { namespace: cfg.namespace, filter: releaseName })
    if (result.includes(releaseName)) {
      await log(`  Found stale release '${releaseName}', cleaning up...`)
      await gx('helm_uninstall', { release: releaseName, namespace: cfg.namespace })
      await log('  Stale release removed ✓')
    }
  } catch {
    // No existing release — nothing to clean up
  }
}

async function bootstrapProvider(
  gx: (tool: string, args: Record<string, unknown>) => Promise<string>,
  log: JobLogger,
  cfg: {
    provider: string; hostname: string; namespace: string; clusterIssuer: string
    adminPassword: string; oidcIssuerUrl: string; clientId: string; clientSecret: string
    customIssuerCaSecret: string; databaseType: string; redisHost: string; isDocker: boolean
  },
): Promise<void> {
  // Full namespace cleanup for Authentik — Helm uninstall alone leaves behind
  // manually-patched deployments, services, PVCs, and secrets that conflict
  // with the new Helm-managed resources.
  if (cfg.provider === 'authentik') {
    await log('Cleaning all stale Authentik resources...')
    // Helm uninstall — removes Helm-managed resources (deployment, statefulset, services, secrets, etc.)
    await gx('helm_uninstall', { release: 'authentik', namespace: cfg.namespace, timeout: '120s' }).catch(() => {})
    // Delete remaining workloads (bootstrap-created ones that Helm doesn't manage)
    await gx('kubectl_delete', { resource: 'statefulset', name: 'authentik-redis', namespace: cfg.namespace }).catch(() => {})
    await gx('kubectl_delete', { resource: 'deployment', name: 'authentik-redis', namespace: cfg.namespace }).catch(() => {})
    await gx('kubectl_delete', { resource: 'statefulset', name: 'authentik-postgresql', namespace: cfg.namespace }).catch(() => {})
    // Delete PVCs (Helm uninstall may not always succeed in deleting PVCs)
    await gx('kubectl_delete', { resource: 'pvc', name: 'postgres-data-authentik-postgresql-0', namespace: cfg.namespace }).catch(() => {})
    await gx('kubectl_delete', { resource: 'pvc', name: 'data-authentik-postgresql-0', namespace: cfg.namespace }).catch(() => {})
    await gx('kubectl_delete', { resource: 'pvc', name: 'redis-data-authentik-redis-0', namespace: cfg.namespace }).catch(() => {})
    // Delete secrets that could conflict with new deployment
    const SECRET_NAMES = ['authentik', 'authentik-secrets', 'authentik-secret-key', 'authentik-root-password', 'authentik-secret-fix', 'authentik-postgresql']
    for (const sn of SECRET_NAMES) {
      await gx('kubectl_delete', { resource: 'secret', name: sn, namespace: cfg.namespace }).catch(() => {})
    }
    // Delete bootstrap-created services that Helm may have missed
    const SVC_NAMES = ['authentik-server', 'authentik-postgresql', 'authentik-redis', 'authentik-worker', 'authentik-goauthentikio']
    for (const sv of SVC_NAMES) {
      await gx('kubectl_delete', { resource: 'service', name: sv, namespace: cfg.namespace }).catch(() => {})
    }
    // Delete ingress routes
    await gx('kubectl_delete', { resource: 'ingress', name: 'authentik', namespace: cfg.namespace }).catch(() => {})
    // Delete cert-manager resources that can block SSL renewal
    await gx('kubectl_delete', { resource: 'certificate', name: 'authentik-tls', namespace: cfg.namespace }).catch(() => {})
    await gx('kubectl_delete', { resource: 'order', name: 'authentik-tls', namespace: cfg.namespace }).catch(() => {})
    await gx('kubectl_delete', { resource: 'challenge', name: 'authentik-tls', namespace: cfg.namespace }).catch(() => {})
    await log('  Stale resources cleaned ✓')
  } else {
    // Non-Authentik: basic cleanup
    await cleanupStaleHelmRelease(gx, log, cfg)
  }

  await log(`Deploying ${cfg.provider} identity provider to namespace "${cfg.namespace}"`)

  // Ensure namespace exists with PodSecurity bypass (Talos defaults to restricted policy)
  // Always apply — namespace manifests with annotations can be reapplied to add/update annotations
  await gx('kubectl_apply_manifest', {
    manifest: `apiVersion: v1
kind: Namespace
metadata:
  name: ${cfg.namespace}
  annotations:
    pod-security.kubernetes.io/enforce: "privileged"
    pod-security.kubernetes.io/audit: "privileged"
    pod-security.kubernetes.io/warn: "privileged"`,
  })

  // Load provider config (falls back to built-in configs)
  const providerConfig = getProvider(cfg.provider)
  if (!providerConfig) {
    throw new Error(`Unknown SSO provider: ${cfg.provider}`)
  }

  await runProviderDeploy(gx, log, providerConfig, {
    hostname: cfg.hostname,
    namespace: cfg.namespace,
    clusterIssuer: cfg.clusterIssuer,
    adminPassword: cfg.adminPassword,
    provider: cfg.provider,
  })
}

// ── Generic Provider Deployer ────────────────────────────────────────────────

async function runProviderDeploy(
  gx: (tool: string, args: Record<string, unknown>) => Promise<string>,
  log: JobLogger,
  pc: ProviderConfig,
  ctx: { hostname: string; namespace: string; clusterIssuer: string; adminPassword: string; provider: string },
): Promise<void> {
  // Step 1: Cleanup
  if (pc.cleanup) {
    await log(`Cleaning ${pc.name} resources...`)
    if (pc.cleanup.helmRelease) {
      await gx('helm_uninstall', { release: pc.cleanup.helmRelease, namespace: ctx.namespace, timeout: pc.cleanup.helmReleaseTimeout ?? '120s' }).catch(() => {})
    }
    for (const ss of (pc.cleanup.statefulsets ?? [])) {
      await gx('kubectl_delete', { resource: 'statefulset', name: ss, namespace: ctx.namespace }).catch(() => {})
    }
    for (const d of (pc.cleanup.deployments ?? [])) {
      await gx('kubectl_delete', { resource: 'deployment', name: d, namespace: ctx.namespace }).catch(() => {})
    }
    for (const prefix of (pc.cleanup.pvcPrefixes ?? [])) {
      await gx('kubectl_delete', { resource: 'pvc', name: `${prefix}*`, namespace: ctx.namespace }).catch(() => {})
    }
    for (const s of (pc.cleanup.secrets ?? [])) {
      await gx('kubectl_delete', { resource: 'secret', name: s, namespace: ctx.namespace }).catch(() => {})
    }
    for (const s of (pc.cleanup.services ?? [])) {
      await gx('kubectl_delete', { resource: 'service', name: s, namespace: ctx.namespace }).catch(() => {})
    }
    await gx('kubectl_delete', { resource: 'ingress', name: pc.name, namespace: ctx.namespace }).catch(() => {})
    for (const cert of (pc.cleanup.certificates ?? [])) {
      await gx('kubectl_delete', { resource: 'certificate', name: cert, namespace: ctx.namespace }).catch(() => {})
    }
    for (const ch of (pc.cleanup.challenges ?? [])) {
      await gx('kubectl_delete', { resource: 'challenge', name: ch, namespace: ctx.namespace }).catch(() => {})
    }
    for (const o of (pc.cleanup.orders ?? [])) {
      await gx('kubectl_delete', { resource: 'order', name: o, namespace: ctx.namespace }).catch(() => {})
    }
    await log(`  ${pc.name} cleanup done ✓`)
  }

  // Step 2: Apply provider-specific manifests
  if (pc.manifests) {
    for (const manifest of pc.manifests) {
      await gx('kubectl_apply_manifest', { manifest })
    }
  }

  // Step 3: Helm install/upgrade
  if (pc.helm) {
    await log(`Installing ${pc.name} via Helm...`)
    await gx('helm_upgrade_install', {
      release: pc.helm.release, chart: pc.helm.chart, repo: pc.helm.repo,
      namespace: ctx.namespace, createNamespace: false,
      valuesFile: pc.rawValues ?? JSON.stringify(pc.helm.values),
      wait: pc.helm.wait, timeout: pc.helm.timeout ?? '300s',
    })
    await log(`  ${pc.name} Helm deployed ✓`)

    // Step 4: Wait for PostgreSQL (if configured)
    if (pc.waitForReady?.statefulset) {
      await log(`  Waiting for ${pc.waitForReady.statefulset.name}...`)
      await waitForResource(gx, 'statefulset', pc.waitForReady.statefulset.name, ctx.namespace, 'ready', pc.waitForReady.statefulset.timeout)
      await log(`  PostgreSQL ready ✓`)
    }

    // Step 5: Extract and sync overlay secret
    if (pc.overlaySecret) {
      await log(`  Syncing overlay secret ${pc.overlaySecret.name}...`)
      await syncOverlaySecret(gx, log, pc.overlaySecret, pc, ctx)
      await log(`  Overlay secret synced ✓`)
    }

    // Step 6: Patch deployments
    for (const dep of pc.deployments) {
      if (pc.overlaySecret) {
        await gx('kubectl_patch', {
          resource: 'deployment', name: dep.name, namespace: ctx.namespace,
          patchType: 'strategic',
          patch: JSON.stringify({
            spec: {
              template: {
                spec: {
                  containers: [{
                    name: dep.containerName,
                    envFrom: [
                      { secretRef: { name: pc.helm!.release } },
                      { secretRef: { name: pc.overlaySecret.name } },
                    ],
                  }],
                },
              },
            },
          }),
        })
      }
    }

    // Step 7: Delete old pods to pick up envFrom
    for (const dep of pc.deployments) {
      const label = dep.name === pc.overlaySecret?.name ? dep.name : `app.kubernetes.io/component=${dep.name.replace(pc.name + '-', '')}`
      await gx('kubectl_delete', { resource: 'pods', namespace: ctx.namespace, selector: label }).catch(() => {})
    }

    // Step 8: Wait for server readiness
    if (pc.waitForReady?.deployment) {
      await log(`  Waiting for ${pc.name} to be ready...`)
      await waitForResource(gx, 'deployment', pc.waitForReady.deployment.name, ctx.namespace, 'ready', pc.waitForReady.deployment.timeout)
    }

    await log(`${pc.name} deployed successfully ✓`)
  } else {
    // Non-Helm deployment: just apply manifests
    await log(`${pc.name} deployed ✓`)
  }
}

/**
 * Sync the overlay secret: create or update it with resolved values.
 * Handles {{ resolveSecret <secret> <key> }} placeholders.
 */
async function syncOverlaySecret(
  gx: (tool: string, args: Record<string, unknown>) => Promise<string>,
  log: JobLogger,
  overlay: ProviderConfig['overlaySecret'],
  pc: ProviderConfig,
  ctx: { hostname: string; namespace: string; clusterIssuer: string; adminPassword: string; provider: string },
): Promise<void> {
  // Collect all secret values
  const stringData: Record<string, string> = {}

  for (const entry of overlay.entries) {
    let value = entry.value

    // Resolve {{ adminPassword }}, {{ hostname }}, etc.
    value = value.replace(/\{\{\s*adminPassword\s*\}\}/g, ctx.adminPassword)
    value = value.replace(/\{\{\s*hostname\s*\}\}/g, ctx.hostname)
    value = value.replace(/\{\{\s*clusterIssuer\s*\}\}/g, ctx.clusterIssuer)
    value = value.replace(/\{\{\s*provider\s*\}\}/g, ctx.provider)
    value = value.replace(/\{\{\s*namespace\s*\}\}/g, ctx.namespace)

    // Resolve {{ resolveSecret <name> <key> }} — extract from cluster
    value = value.replace(/\{\{\s*resolveSecret\s+(\S+)\s+(\S+)\s*\}\}/g, async (_match, secretName, secretKey) => {
      // This is called synchronously — we need a sync resolution
      // The actual resolution happens in the loop below
      return `__PLACEHOLDER_${secretName}_${secretKey}__`
    })

    stringData[entry.key] = value
  }

  // Now resolve all the placeholders by reading from the cluster
  for (const [key, value] of Object.entries(stringData)) {
    const match = value.match(/^__PLACEHOLDER_(.+)_([a-zA-Z_]+)__$/)
    if (match) {
      const [_, secretName, secretKey] = match
      try {
        const result = await gx('kubectl_get', {
          resource: 'secret', name: secretName, namespace: ctx.namespace, output: 'json',
        })
        const data = JSON.parse(result).data?.[secretKey]
        if (data) {
          stringData[key] = Buffer.from(data, 'base64').toString('utf8')
        }
      } catch {
        log(`  WARNING: Could not resolve secret ${secretName}.${secretKey} for key ${key}`)
      }
    }
  }

  // Build the manifest
  const manifestLines: string[] = [
    'apiVersion: v1',
    'kind: Secret',
    'metadata:',
    `  name: ${overlay.name}`,
    `  namespace: ${ctx.namespace}`,
    'type: Opaque',
    'stringData:',
  ]
  for (const [key, value] of Object.entries(stringData)) {
    // Escape double quotes and backslashes in values
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    manifestLines.push(`  ${key}: "${escaped}"`)
  }

  await gx('kubectl_apply_manifest', { manifest: manifestLines.join('\n') })
}

/**
 * Wait for a resource to reach ready state.
 */
async function waitForResource(
  gx: (tool: string, args: Record<string, unknown>) => Promise<string>,
  kind: string,
  name: string,
  namespace: string,
  target: string,
  timeoutSec: number,
): Promise<void> {
  const start = Date.now()
  const interval = 5
  while (Date.now() - start < timeoutSec * 1000) {
    await new Promise(r => setTimeout(r, interval * 1000))

    if (target === 'ready' && (kind === 'statefulset' || kind === 'deployment')) {
      const result = await gx('kubectl_get', {
        resource: kind, name, namespace, output: 'json',
      })
      try {
        const obj = JSON.parse(result)
        if (obj.status?.readyReplicas !== undefined && obj.status.readyReplicas > 0) {
          return
        }
        const conditions = obj.status?.conditions || []
        const available = conditions.find((c: { type: string; status: string }) => c.type === 'Available' && c.status === 'True')
        const progressing = conditions.find((c: { type: string; status: string }) => c.type === 'Progressing')
        if (available && !progressing) {
          return
        }
      } catch {
        if (!result.includes('"code":404') && !result.includes('"kind":')) {
          throw new Error(`${kind}/${name} not found after ${Math.round((Date.now() - start) / 1000)}s`)
        }
      }
    }

    const elapsed = Math.round((Date.now() - start) / 1000)
    if (elapsed % 30 === 0) {
      // Log progress every 30s
    }
  }
  throw new Error(`Timed out waiting ${timeoutSec}s for ${kind}/${name} to reach ${target}`)
}

// ── Backwards-compatible: each provider also has its own deploy function
// ── The generic runProviderDeploy is preferred for new deployments ─────────
