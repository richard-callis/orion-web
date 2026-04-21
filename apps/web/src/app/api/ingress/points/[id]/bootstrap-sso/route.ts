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
import { getProvider, renderProviderConfig, type ProviderConfig } from '@/lib/provider-engine'

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

async function bootstrapProvider(
  gx: (tool: string, args: Record<string, unknown>) => Promise<string>,
  log: JobLogger,
  cfg: {
    provider: string; hostname: string; namespace: string; clusterIssuer: string
    adminPassword: string; oidcIssuerUrl: string; clientId: string; clientSecret: string
    customIssuerCaSecret: string; databaseType: string; redisHost: string; isDocker: boolean
  },
): Promise<void> {
  // Load and render provider config (resolves from remote if not bundled)
  const pcRaw = await getProvider(cfg.provider)
  if (!pcRaw) {
    throw new Error(`Unknown SSO provider: ${cfg.provider}`)
  }
  const pc = renderProviderConfig(pcRaw, {
    hostname: cfg.hostname,
    namespace: cfg.namespace,
    clusterIssuer: cfg.clusterIssuer,
    adminPassword: cfg.adminPassword,
    provider: cfg.provider,
    genSecrets: {},
  })

  // Cleanup via provider config
  if (pc.cleanup) {
    await log(`Cleaning ${pc.name} resources...`)
    if (pc.cleanup.helmRelease) {
      await gx('helm_uninstall', { release: pc.cleanup.helmRelease, namespace: cfg.namespace, timeout: pc.cleanup.helmReleaseTimeout ?? '120s' }).catch(() => {})
    }
    for (const ss of (pc.cleanup.statefulsets ?? [])) {
      await gx('kubectl_delete', { resource: 'statefulset', name: ss, namespace: cfg.namespace }).catch(() => {})
    }
    for (const d of (pc.cleanup.deployments ?? [])) {
      await gx('kubectl_delete', { resource: 'deployment', name: d, namespace: cfg.namespace }).catch(() => {})
    }
    for (const prefix of (pc.cleanup.pvcPrefixes ?? [])) {
      await gx('kubectl_delete', { resource: 'pvc', name: `${prefix}*`, namespace: cfg.namespace }).catch(() => {})
    }
    for (const s of (pc.cleanup.secrets ?? [])) {
      await gx('kubectl_delete', { resource: 'secret', name: s, namespace: cfg.namespace }).catch(() => {})
    }
    for (const s of (pc.cleanup.services ?? [])) {
      await gx('kubectl_delete', { resource: 'service', name: s, namespace: cfg.namespace }).catch(() => {})
    }
    await gx('kubectl_delete', { resource: 'ingress', name: pc.name, namespace: cfg.namespace }).catch(() => {})
    for (const cert of (pc.cleanup.certificates ?? [])) {
      await gx('kubectl_delete', { resource: 'certificate', name: cert, namespace: cfg.namespace }).catch(() => {})
    }
    for (const ch of (pc.cleanup.challenges ?? [])) {
      await gx('kubectl_delete', { resource: 'challenge', name: ch, namespace: cfg.namespace }).catch(() => {})
    }
    for (const o of (pc.cleanup.orders ?? [])) {
      await gx('kubectl_delete', { resource: 'order', name: o, namespace: cfg.namespace }).catch(() => {})
    }
    await log(`  ${pc.name} cleanup done ✓`)
  }

  await log(`Deploying ${pc.name} identity provider to namespace "${cfg.namespace}"`)

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

  // Run deploy (cleanup already done above)
  await runProviderDeploy(gx, log, pc, {
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
  // Step 1: Apply provider-specific manifests
  if (pc.manifests) {
    for (const manifest of pc.manifests) {
      await gx('kubectl_apply_manifest', { manifest })
    }
  }

  // Step 2: Helm install/upgrade
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

    // Step 7: Delete pods to pick up envFrom changes
    // Helm charts use varying label conventions — safest to delete all workload pods
    for (const res of ['deployment', 'statefulset'] as const) {
      const list = await gx('kubectl_get', { resource: res, namespace: ctx.namespace, output: 'json' })
      try {
        const items = JSON.parse(list).items || []
        for (const item of items) {
          const podName = item.metadata.name
          await gx('kubectl_delete', { resource: 'pod', name: podName, namespace: ctx.namespace }).catch(() => {})
        }
      } catch {
        // Parse error — skip
      }
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
  overlay: NonNullable<ProviderConfig['overlaySecret']>,
  pc: ProviderConfig,
  ctx: { hostname: string; namespace: string; clusterIssuer: string; adminPassword: string; provider: string },
): Promise<void> {
  const placeholderRe = /\{\{\s*resolveSecret\s+(\S+)\s+(\S+)\s*\}\}/g

  // Step 1: Collect regular entries (with placeholders) and resolve targets
  const stringData: Record<string, string> = {}
  const resolveTargets: Array<{ placeholder: string; secretName: string; secretKey: string }> = []

  for (const entry of overlay.entries) {
    let value = entry.value

    // Resolve {{ adminPassword }}, {{ hostname }}, etc.
    value = value.replace(/\{\{\s*adminPassword\s*\}\}/g, ctx.adminPassword)
    value = value.replace(/\{\{\s*hostname\s*\}\}/g, ctx.hostname)
    value = value.replace(/\{\{\s*clusterIssuer\s*\}\}/g, ctx.clusterIssuer)
    value = value.replace(/\{\{\s*provider\s*\}\}/g, ctx.provider)
    value = value.replace(/\{\{\s*namespace\s*\}\}/g, ctx.namespace)

    // Replace resolveSecret with unique placeholders, collecting targets
    value = value.replace(placeholderRe, (_: string, secretName: string, secretKey: string) => {
      const ph = `__RS_${secretName}_${secretKey}__`
      resolveTargets.push({ placeholder: ph, secretName, secretKey })
      return ph
    })

    stringData[entry.key] = value
  }

  // Step 2: Resolve all placeholders from cluster
  for (const target of resolveTargets) {
    try {
      const result = await gx('kubectl_get', {
        resource: 'secret', name: target.secretName, namespace: ctx.namespace, output: 'json',
      })
      const data = JSON.parse(result).data?.[target.secretKey]
      if (data) {
        const resolvedValue = Buffer.from(data, 'base64').toString('utf8')
        // Replace placeholder in all stringData values
        for (const [key, val] of Object.entries(stringData)) {
          stringData[key] = val.replace(new RegExp(`\\{\\{\\s*${target.placeholder}\\s*\\}\\}`, 'g'), resolvedValue)
        }
      }
    } catch {
      log(`  WARNING: Could not resolve secret ${target.secretName}.${target.secretKey}`)
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
