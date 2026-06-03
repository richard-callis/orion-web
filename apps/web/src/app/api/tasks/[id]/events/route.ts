import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'

const VALID_TASK_STATUSES = new Set([
  'pending', 'in_progress', 'pending_validation', 'done', 'failed', 'blocked',
])

// GET /api/tasks/:id/events — fetch all events for a task
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  await requireServiceAuth(req)
  const events = await prisma.taskEvent.findMany({
    where: { taskId: params.id },
    orderBy: { createdAt: 'asc' },
  })
  return NextResponse.json(events)
}

// POST /api/tasks/:id/events — add a comment/status event to a task
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const caller = await requireServiceAuth(req)

  const body = await req.json()

  // Validate status transitions — prevents bypassing Veritas by driving tasks
  // directly to 'done' via this route without going through pending_validation.
  if (body.status !== undefined) {
    const statusStr = String(body.status)
    if (!VALID_TASK_STATUSES.has(statusStr)) {
      return NextResponse.json(
        { error: `Invalid status '${statusStr}'. Must be one of: ${[...VALID_TASK_STATUSES].join(', ')}` },
        { status: 400 },
      )
    }
    // Agents (non-admin service tokens) cannot transition directly to 'done' —
    // that gate belongs to Veritas via orion_close_task which requires pending_validation first.
    if (statusStr === 'done' && caller?.role !== 'admin') {
      return NextResponse.json(
        { error: "Cannot set status 'done' directly — transition to 'pending_validation' first, then use orion_close_task" },
        { status: 403 },
      )
    }
  }

  const event = await prisma.taskEvent.create({
    data: {
      taskId:    params.id,
      eventType: body.eventType ?? 'comment',
      content:   body.content ?? null,
      agentId:   typeof (caller as any)?.agentId === 'string' ? (caller as any).agentId : null,
    },
  })

  if (body.status) {
    await prisma.task.update({ where: { id: params.id }, data: { status: body.status } })
  }

  return NextResponse.json(event, { status: 201 })
}
