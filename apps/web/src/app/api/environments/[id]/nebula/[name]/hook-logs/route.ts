import { NextRequest, NextResponse } from 'next/server'
import { requireGatewayAuthForEnvironment } from '@/lib/auth'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * GET /api/environments/[id]/nebula/[name]/hook-logs
 * Retrieve hook execution logs for a nebula entry.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; name: string } }
) {
  const { id } = params
  await requireGatewayAuthForEnvironment(req, id).catch(() => { throw Object.assign(new Error('Unauthorized'), {status:401}) })

  const logs = await prisma.hookExecutionLog.findMany({
    where: { nebula: { environmentId: params.id, name: params.name } },
    orderBy: { startedAt: 'desc' },
    take: 50,
  })
  return NextResponse.json(logs)
}

/**
 * POST /api/environments/[id]/nebula/[name]/hook-logs
 * Report a hook execution result.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; name: string } }
) {
  const { id } = params
  await requireGatewayAuthForEnvironment(req, id).catch(() => { throw Object.assign(new Error('Unauthorized'), {status:401}) })

  const body = await req.json()
  const entry = await prisma.nebulaInstance.findFirst({
    where: { environmentId: params.id, name: params.name },
  })
  if (!entry) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const log = await prisma.hookExecutionLog.create({
    data: {
      nebulaId: entry.id,
      triggerEvent: body.triggerEvent,
      triggerData: body.triggerData,
      actionType: body.actionType,
      status: body.status,
      output: body.output,
      startedAt: body.startedAt ? new Date(body.startedAt) : undefined,
      durationMs: body.durationMs,
    },
  })
  return NextResponse.json(log)
}
