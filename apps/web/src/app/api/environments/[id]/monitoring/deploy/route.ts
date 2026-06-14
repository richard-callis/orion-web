/**
 * POST /api/environments/:id/monitoring/deploy
 *
 * Deploys a monitoring stack to an existing K8s environment.
 * Returns { jobId } immediately — client polls GET /api/jobs/:id for progress.
 * Body: { stack: 'basic' | 'full' }
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { startJob } from '@/lib/job-runner'
import { deployMonitoringStack, type BootstrapEvent } from '@/lib/cluster-bootstrap'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const body = await req.json() as { stack?: string }
  const stack = body.stack

  if (stack !== 'basic' && stack !== 'full') {
    return NextResponse.json({ error: 'stack must be "basic" or "full"' }, { status: 400 })
  }

  const env = await prisma.environment.findUnique({ where: { id } })
  if (!env) return NextResponse.json({ error: 'Environment not found' }, { status: 404 })
  if (env.type !== 'cluster') {
    return NextResponse.json({ error: 'Monitoring deployment is only supported for Kubernetes environments' }, { status: 400 })
  }
  if (!env.kubeconfig) {
    return NextResponse.json({ error: 'No kubeconfig stored for this environment' }, { status: 400 })
  }

  const activeJob = await prisma.backgroundJob.findFirst({
    where: { type: 'monitoring-deploy', environmentId: id, status: { in: ['queued', 'running'] } },
  })
  if (activeJob) {
    return NextResponse.json({ error: 'A monitoring deployment is already in progress', jobId: activeJob.id }, { status: 409 })
  }

  const jobId = await startJob(
    'monitoring-deploy',
    `Deploy monitoring (${stack}): ${env.name}`,
    { environmentId: id },
    async (log) => {
      const emit = (event: BootstrapEvent) => {
        const prefix = event.type === 'step' ? '▶' : event.type === 'error' ? '✗' : event.type === 'done' ? '✓' : ' '
        return log(`${prefix} ${event.message}`)
      }
      await deployMonitoringStack(id, stack, emit)
    },
  )

  return NextResponse.json({ jobId }, { status: 202 })
}
