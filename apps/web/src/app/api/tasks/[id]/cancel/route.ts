import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth, assertCanModify } from '@/lib/auth'

/**
 * POST /api/tasks/:id/cancel
 *
 * Cancels a task — used to reject a plan that paused for approval, or to stop a
 * task before it runs. Marks the task 'failed' and records a TaskEvent.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await requireServiceAuth(req)
  const isService = caller === null

  const task = await prisma.task.findUnique({ where: { id: (await params).id } })
  if (!task) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await assertCanModify(caller, isService, task.createdBy)

  const cancelledBy = caller?.id ?? 'gateway'

  await prisma.task.update({ where: { id: task.id }, data: { status: 'failed' } })
  await prisma.taskEvent.create({
    data: {
      taskId: task.id,
      eventType: 'cancelled',
      content: `Cancelled by user (${cancelledBy})`,
      agentId: null,
    },
  })

  return NextResponse.json({ ok: true, id: task.id, status: 'failed' })
}
