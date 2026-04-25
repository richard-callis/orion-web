/**
 * POST /api/environments/:id/bootstrap
 *
 * Creates a BackgroundJob and runs cluster bootstrap asynchronously.
 * Returns {jobId} immediately — client polls GET /api/jobs/:id for progress.
 *
 * Using BackgroundJob instead of SSE avoids Cloudflare's ~100s proxy timeout
 * killing long-running bootstraps. The job completes regardless of whether
 * the client stays connected.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { startJob } from '@/lib/job-runner'
import { bootstrapCluster } from '@/lib/cluster-bootstrap'

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const env = await prisma.environment.findUnique({ where: { id: params.id } })
  if (!env) return NextResponse.json({ error: 'Environment not found' }, { status: 404 })

  const jobId = await startJob(
    'cluster-bootstrap',
    `Bootstrap: ${env.name}`,
    { environmentId: params.id },
    async (log) => {
      await bootstrapCluster(params.id, (event) => {
        const prefix = event.type === 'step'  ? '▶' :
                       event.type === 'error' ? '✗' :
                       event.type === 'done'  ? '✓' : ' '
        log(`${prefix} ${event.message}`)
      })
    },
  )

  return NextResponse.json({ jobId }, { status: 202 })
}
