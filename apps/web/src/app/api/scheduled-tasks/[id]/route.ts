import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth, getCurrentUser } from '@/lib/auth'
import { parseCron, nextRun, minCronIntervalSeconds } from '@/lib/cron'
import { canManageSchedule } from '@/lib/scheduled-task-access'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireServiceAuth(req)
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const task = await prisma.scheduledTask.findUnique({
    where: { id: (await params).id },
    include: { agent: { select: { id: true, name: true } } },
  })

  if (!task) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(task)
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // SOC2 [H4]: only the schedule's owner or an admin (human session) may change it.
  const caller = await getCurrentUser()
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const existing = await prisma.scheduledTask.findUnique({ where: { id: (await params).id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!canManageSchedule(caller, existing.createdBy)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { name, cronExpr, taskTitle, taskDesc, enabled } = body as Record<string, unknown>

  const newCronExpr = typeof cronExpr === 'string' ? cronExpr : existing.cronExpr
  if (typeof cronExpr === 'string' && !parseCron(cronExpr)) {
    return NextResponse.json({ error: `Invalid cron expression: "${cronExpr}"` }, { status: 400 })
  }
  // SOC2 [M-009]: same minimum interval as creation — PUT previously skipped it.
  if (typeof cronExpr === 'string' && minCronIntervalSeconds(cronExpr) < 300) {
    return NextResponse.json({ error: 'Cron expression fires too frequently (minimum interval is 5 minutes)' }, { status: 400 })
  }

  const cronChanged = typeof cronExpr === 'string' && cronExpr !== existing.cronExpr
  const newNextRunAt = cronChanged ? nextRun(newCronExpr) : existing.nextRunAt

  const updated = await prisma.scheduledTask.update({
    where: { id: (await params).id },
    data: {
      ...(typeof name === 'string' && { name }),
      ...(typeof cronExpr === 'string' && { cronExpr }),
      ...(typeof taskTitle === 'string' && { taskTitle }),
      ...(typeof taskDesc === 'string' && { taskDesc }),
      ...(typeof enabled === 'boolean' && { enabled }),
      nextRunAt: newNextRunAt,
    },
    include: { agent: { select: { id: true, name: true } } },
  })

  return NextResponse.json(updated)
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await getCurrentUser()
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const existing = await prisma.scheduledTask.findUnique({ where: { id: (await params).id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!canManageSchedule(caller, existing.createdBy)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  await prisma.scheduledTask.delete({ where: { id: (await params).id } })
  return NextResponse.json({ ok: true })
}
