import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { canManageSchedule } from '@/lib/scheduled-task-access'
import { nextRun } from '@/lib/cron'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // SOC2 [H4]: only the schedule's owner or an admin (human session) may fire it.
  const caller = await getCurrentUser()
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const schedule = await prisma.scheduledTask.findUnique({
    where: { id: (await params).id },
    include: { agent: { select: { id: true } } },
  })
  if (!schedule) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!canManageSchedule(caller, schedule.createdBy)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const now = new Date()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const taskData: any = {
    title:       schedule.taskTitle,
    description: schedule.taskDesc ?? null,
    status:      'pending',
    priority:    'medium',
    assignedAgent: schedule.agentId,
    // Task.createdBy is an FK to User — the literal 'scheduler' violated it and
    // every trigger failed. Attribute the task to the schedule's owner instead.
    createdBy:   schedule.createdBy ?? null,
  }

  if (schedule.taskMeta) {
    try { taskData.metadata = JSON.parse(schedule.taskMeta) } catch { /* ignore */ }
  }

  const task = await prisma.task.create({ data: taskData })

  const computedNextRun = nextRun(schedule.cronExpr, now)

  await Promise.all([
    prisma.scheduledTask.update({
      where: { id: schedule.id },
      data: { lastRunAt: now, lastTaskId: task.id, nextRunAt: computedNextRun },
    }),
    prisma.jobRun.create({
      data: {
        source:     'schedule',
        sourceId:   schedule.id,
        sourceName: schedule.name,
        agentId:    schedule.agentId,
        taskId:     task.id,
        status:     'running',
      },
    }),
  ])

  return NextResponse.json({ taskId: task.id, nextRunAt: computedNextRun })
}
