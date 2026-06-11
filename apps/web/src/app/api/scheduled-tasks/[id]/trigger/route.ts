import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'
import { nextRun } from '@/lib/cron'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  await requireServiceAuth(req)

  const schedule = await prisma.scheduledTask.findUnique({ where: { id: params.id } })
  if (!schedule) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const now = new Date()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const taskData: any = {
    title:       schedule.taskTitle,
    description: schedule.taskDesc ?? null,
    status:      'pending',
    priority:    'medium',
    assignedAgent: schedule.agentId,
    createdBy:   'scheduler',
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
