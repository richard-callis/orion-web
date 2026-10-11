/**
 * POST /api/environments/:id/metrics-server
 *
 * Installs (or updates ORION's own) metrics-server in a cluster environment so
 * the Infrastructure page can show node CPU/memory. Leaves a metrics-server
 * ORION doesn't manage untouched.
 * Returns MetricsServerResult; 502 when the install failed.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { ensureMetricsServer } from '@/lib/metrics-server'

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let userId: string
  try { userId = (await requireAdmin()).id } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const env = await prisma.environment.findUnique({ where: { id: (await params).id } })
  if (!env) return NextResponse.json({ error: 'Environment not found' }, { status: 404 })

  const result = await ensureMetricsServer(env)
  void logAudit({
    userId,
    action: 'environment_update',
    target: `environment:${env.id}`,
    detail: { event: 'metrics_server_install', environmentId: env.id, ...result },
  })

  if (result.status === 'error') return NextResponse.json(result, { status: 502 })
  return NextResponse.json(result)
}
