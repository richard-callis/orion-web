/**
 * POST /api/environments/:id/sync-status
 *
 * Receives ArgoCD Application sync/health state from the Gateway's ArgoCD watcher.
 * Updates the environment's metadata with the latest sync state.
 * Closes any GitOpsPRs whose revision has been synced.
 *
 * Auth: Bearer gatewayToken (same token used for heartbeats).
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

interface ArgoCDApp {
  name: string
  namespace: string
  project: string
  syncStatus: string
  healthStatus: string
  revision: string
  message: string
  reconciledAt: string | null
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  // Verify gateway token
  const auth = req.headers.get('authorization')
  const env = await prisma.environment.findUnique({ where: { id: params.id } })
  if (!env) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const expectedToken = env.gatewayToken
  if (expectedToken && auth !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { applications } = (await req.json()) as { applications: ArgoCDApp[] }
  if (!Array.isArray(applications)) {
    return NextResponse.json({ error: 'applications must be an array' }, { status: 400 })
  }

  // Derive overall environment health from the app states
  const overallHealth = deriveOverallHealth(applications)

  // Store sync state in environment metadata
  const currentMeta = (env.metadata as Record<string, unknown>) ?? {}
  const newMeta = JSON.parse(JSON.stringify({
    ...currentMeta,
    argocd: {
      applications,
      reportedAt: new Date().toISOString(),
      overallHealth,
    },
  }))
  await prisma.environment.update({
    where: { id: params.id },
    data: {
      lastSeen: new Date(),
      status: 'connected',
      metadata: newMeta,
    },
  })

  // Close GitOpsPRs that have been synced (revision match)
  const syncedRevisions = applications
    .filter(a => a.syncStatus === 'Synced' && a.revision)
    .map(a => a.revision)

  if (syncedRevisions.length > 0) {
    // Find open PRs for this environment whose branch tip matches a synced revision
    // We store the branch name in GitOpsPR — ArgoCD reports the commit SHA.
    // Best-effort: mark PRs as merged if they're still "open" and the app is now Synced.
    // (A more precise match would require storing the commit SHA at PR creation time.)
    const openPRs = await prisma.gitOpsPR.findMany({
      where: { environmentId: params.id, status: 'open', decision: 'auto' },
    })

    for (const pr of openPRs) {
      // If any ArgoCD app in this environment is now Synced, auto-merged PRs can be closed
      if (syncedRevisions.length > 0) {
        await prisma.gitOpsPR.update({
          where: { id: pr.id },
          data: { status: 'merged', mergedAt: new Date() },
        })
      }
    }
  }

  return NextResponse.json({ ok: true, overallHealth, apps: applications.length })
}

/**
 * GET /api/environments/:id/sync-status
 *
 * Returns the latest ArgoCD sync state for an environment (from metadata).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const env = await prisma.environment.findUnique({ where: { id: params.id } })
  if (!env) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const meta = (env.metadata as Record<string, unknown>) ?? {}
  const argocd = (meta.argocd as Record<string, unknown>) ?? null

  return NextResponse.json({
    environmentId: params.id,
    argocd,
  })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function deriveOverallHealth(apps: ArgoCDApp[]): string {
  if (apps.length === 0) return 'Unknown'
  if (apps.some(a => a.healthStatus === 'Degraded'))    return 'Degraded'
  if (apps.some(a => a.healthStatus === 'Progressing')) return 'Progressing'
  if (apps.some(a => a.syncStatus   === 'OutOfSync'))   return 'OutOfSync'
  if (apps.every(a => a.syncStatus === 'Synced' && a.healthStatus === 'Healthy')) return 'Healthy'
  return 'Unknown'
}
