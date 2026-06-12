import { NextRequest, NextResponse } from 'next/server'
import { requireGatewayAuthForEnvironment } from '@/lib/auth'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

/** POST /api/environments/[id]/nebula/hook/report — Report hook execution result */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params
  await requireGatewayAuthForEnvironment(req, id).catch(() => { throw Object.assign(new Error('Unauthorized'), {status:401}) })

  const body = await req.json()
  const { nebulaId, triggerEvent, triggerData, actionType, status, output, startedAt, durationMs } = body

  // Find the nebula instance
  const nebula = await prisma.nebulaInstance.findFirst({
    where: { id: nebulaId, environmentId: params.id },
  })
  if (!nebula) {
    return NextResponse.json({ error: 'NebulaInstance not found' }, { status: 404 })
  }

  await prisma.hookExecutionLog.create({
    data: {
      nebulaId: nebula.id,
      triggerEvent,
      triggerData,
      actionType,
      status: status || 'success',
      output,
      startedAt: startedAt ? new Date(startedAt) : new Date(),
      completedAt: durationMs
        ? new Date((startedAt ? new Date(startedAt).getTime() : Date.now()) + durationMs)
        : undefined,
      durationMs: durationMs,
    },
  })

  return NextResponse.json({ ok: true })
}
