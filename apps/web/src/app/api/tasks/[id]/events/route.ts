import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

// GET /api/tasks/:id/events — fetch all events for a task
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const events = await prisma.taskEvent.findMany({
    where: { taskId: params.id },
    orderBy: { createdAt: 'asc' },
  })
  return NextResponse.json(events)
}

// POST /api/tasks/:id/events — add a comment/status event to a task
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  const event = await prisma.taskEvent.create({
    data: {
      taskId:    params.id,
      eventType: body.eventType ?? 'comment', // comment | status_change | note
      content:   body.content ?? null,
    },
  })
  // Optionally update task status at the same time
  if (body.status) {
    await prisma.task.update({ where: { id: params.id }, data: { status: body.status } })
  }
  return NextResponse.json(event, { status: 201 })
}
