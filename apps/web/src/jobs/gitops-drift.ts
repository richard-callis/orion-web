/**
 * GitOps Drift Detection Job
 *
 * Compares live Kubernetes cluster state against desired state by querying
 * ArgoCD application sync status (stored in environment metadata) and/or
 * querying the gateway for live deployment replica counts.
 *
 * Runs every 5 minutes from worker.ts.
 */

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { GatewayClient } from '@/lib/agent-runner/gateway-client'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DriftFinding {
  resource: string
  namespace: string
  kind: string
  field: string
  desired: string
  actual: string
  severity: 'low' | 'medium' | 'high'
}

interface ArgoCDApp {
  name: string
  namespace: string
  project: string
  syncStatus: string      // Synced | OutOfSync | Unknown
  healthStatus: string    // Healthy | Degraded | Progressing | Suspended | Missing | Unknown
  revision: string
  message: string
  reconciledAt: string | null
}

interface K8sDeployment {
  metadata: { name: string; namespace: string }
  spec:     { replicas?: number }
  status:   { readyReplicas?: number; availableReplicas?: number; replicas?: number }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg: string) { process.stdout.write(`[drift-detector] ${msg}\n`) }
function err(msg: string) { process.stderr.write(`[drift-detector] ERROR: ${msg}\n`) }

/**
 * Derive DriftFindings from ArgoCD application status already cached in
 * environment.metadata.argocd (populated by POST /api/environments/:id/sync-status).
 */
function findingsFromArgoCD(apps: ArgoCDApp[]): DriftFinding[] {
  const findings: DriftFinding[] = []

  for (const app of apps) {
    if (app.syncStatus === 'OutOfSync') {
      findings.push({
        resource:  app.name,
        namespace: app.namespace || 'argocd',
        kind:      'Application',
        field:     'syncStatus',
        desired:   'Synced',
        actual:    'OutOfSync',
        severity:  'high',
      })
    }

    if (app.healthStatus === 'Degraded') {
      findings.push({
        resource:  app.name,
        namespace: app.namespace || 'argocd',
        kind:      'Application',
        field:     'healthStatus',
        desired:   'Healthy',
        actual:    'Degraded',
        severity:  'high',
      })
    } else if (app.healthStatus === 'Progressing') {
      findings.push({
        resource:  app.name,
        namespace: app.namespace || 'argocd',
        kind:      'Application',
        field:     'healthStatus',
        desired:   'Healthy',
        actual:    'Progressing',
        severity:  'medium',
      })
    } else if (app.healthStatus === 'Missing') {
      findings.push({
        resource:  app.name,
        namespace: app.namespace || 'argocd',
        kind:      'Application',
        field:     'healthStatus',
        desired:   'Healthy',
        actual:    'Missing',
        severity:  'high',
      })
    }
  }

  return findings
}

/**
 * Fallback: query the gateway's kubectl_get tool to list deployments and
 * compare desired replicas vs ready replicas.
 */
async function findingsFromKubectl(client: GatewayClient): Promise<DriftFinding[]> {
  const findings: DriftFinding[] = []

  let raw: string
  try {
    raw = await client.executeTool('kubectl_get', {
      resource: 'deployments',
      output:   'json',
    })
  } catch (e) {
    // Gateway may not have this tool or may not be reachable — return empty
    return findings
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return findings
  }

  // kubectl returns { items: [...] } for a list
  const items: K8sDeployment[] = Array.isArray((parsed as any)?.items)
    ? (parsed as any).items
    : []

  for (const dep of items) {
    const name      = dep.metadata?.name      ?? 'unknown'
    const namespace = dep.metadata?.namespace ?? 'default'
    const desired   = dep.spec?.replicas      ?? 1
    const ready     = dep.status?.readyReplicas ?? 0

    if (ready < desired) {
      findings.push({
        resource:  name,
        namespace,
        kind:      'Deployment',
        field:     'readyReplicas',
        desired:   String(desired),
        actual:    String(ready),
        severity:  ready === 0 ? 'high' : 'medium',
      })
    }
  }

  return findings
}

// ── Per-environment scanner ────────────────────────────────────────────────────

async function scanEnvironment(env: {
  id: string
  name: string
  gatewayUrl: string | null
  gatewayToken: string | null
  metadata: unknown
  monitoringConfig: unknown
}): Promise<void> {
  const monCfg = (env.monitoringConfig ?? {}) as Record<string, unknown>
  const meta   = (env.metadata         ?? {}) as Record<string, unknown>

  log(`Scanning environment "${env.name}" (${env.id})`)

  let findings: DriftFinding[] = []
  let reportStatus = 'clean'

  try {
    // ── Strategy 1: Use ArgoCD state cached in environment.metadata ────────────
    const argocdMeta = meta.argocd as { applications?: ArgoCDApp[]; reportedAt?: string } | undefined
    if (argocdMeta?.applications?.length) {
      const ageMs = argocdMeta.reportedAt
        ? Date.now() - new Date(argocdMeta.reportedAt).getTime()
        : Infinity
      // Only use cached ArgoCD state if it's less than 10 minutes old
      if (ageMs < 10 * 60 * 1000) {
        findings = findingsFromArgoCD(argocdMeta.applications)
        log(`  → ArgoCD: ${argocdMeta.applications.length} apps, ${findings.length} finding(s)`)
      } else {
        log(`  → ArgoCD state stale (${Math.round(ageMs / 60000)}m) — falling back to kubectl`)
      }
    }

    // ── Strategy 2: If no ArgoCD state, query gateway kubectl ─────────────────
    if (findings.length === 0 && env.gatewayUrl) {
      const client = new GatewayClient(env.gatewayUrl, env.gatewayToken ?? '')
      findings = await findingsFromKubectl(client)
      log(`  → kubectl: ${findings.length} finding(s)`)
    }

    reportStatus = findings.length > 0 ? 'drifted' : 'clean'
  } catch (e) {
    err(`Scan failed for "${env.name}": ${e}`)
    reportStatus = 'error'
    findings = []
  }

  // Persist the report
  await prisma.driftReport.create({
    data: {
      environmentId: env.id,
      status:        reportStatus,
      driftCount:    findings.length,
      findings:      JSON.stringify(findings),
      scannedAt:     new Date(),
    },
  })

  if (reportStatus === 'drifted') {
    const highCount = findings.filter(f => f.severity === 'high').length
    log(`  ⚠ DRIFTED: ${findings.length} finding(s), ${highCount} high-severity — environment "${env.name}"`)
  }

  // Prune old reports — keep only the last 100 per environment to bound table size
  const oldest = await prisma.driftReport.findMany({
    where:   { environmentId: env.id },
    orderBy: { scannedAt: 'desc' },
    skip:    100,
    select:  { id: true },
  })
  if (oldest.length > 0) {
    await prisma.driftReport.deleteMany({
      where: { id: { in: oldest.map(r => r.id) } },
    })
  }
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Scan all eligible environments for GitOps drift.
 * Eligible: has a gateway connected OR has monitoringConfig.gitopsEnabled === true.
 */
export async function detectGitOpsDrift(): Promise<void> {
  // Find environments that have a gateway URL or have gitopsEnabled set
  const envs = await prisma.environment.findMany({
    where: {
      OR: [
        { gatewayUrl: { not: null } },
        // monitoringConfig is a JSON column — environments with gitopsEnabled will
        // also be caught by having a gatewayUrl in practice, but include explicit check
        { monitoringConfig: { not: Prisma.DbNull } },
      ],
    },
    select: {
      id:              true,
      name:            true,
      gatewayUrl:      true,
      gatewayToken:    true,
      metadata:        true,
      monitoringConfig: true,
    },
  })

  // Filter: must either have gatewayUrl, or monitoringConfig.gitopsEnabled === true
  const eligible = envs.filter(env => {
    if (env.gatewayUrl) return true
    const cfg = (env.monitoringConfig ?? {}) as Record<string, unknown>
    return cfg.gitopsEnabled === true
  })

  if (eligible.length === 0) {
    log('No eligible environments — skipping drift scan')
    return
  }

  log(`Starting drift scan for ${eligible.length} environment(s)`)

  for (const env of eligible) {
    try {
      await scanEnvironment(env)
    } catch (e) {
      err(`Unhandled error scanning "${env.name}": ${e}`)
    }
  }

  log('Drift scan complete')
}

/**
 * Scan a single environment by ID. Used by the manual trigger API endpoint.
 */
export async function detectGitOpsDriftForEnv(environmentId: string): Promise<void> {
  const env = await prisma.environment.findUnique({
    where:  { id: environmentId },
    select: {
      id:               true,
      name:             true,
      gatewayUrl:       true,
      gatewayToken:     true,
      metadata:         true,
      monitoringConfig: true,
    },
  })
  if (!env) throw new Error(`Environment ${environmentId} not found`)
  await scanEnvironment(env)
}
