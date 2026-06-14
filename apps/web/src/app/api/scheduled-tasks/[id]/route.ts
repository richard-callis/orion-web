import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth, assertCanModify } from '@/lib/auth'
import { parseCron, nextRun } from '@/lib/cron'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await requireServiceAuth(req)
  const isService = caller === null

  const task = await prisma.scheduledTask.findUnique({
    where: { id: (await params).id },
    include: { agent: { select: { id: true, name: true } } },
  })

  if (!task) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await assertCanModify(caller, isService, task.createdBy)
  return NextResponse.json(task)
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await requireServiceAuth(req)
  const isService = caller === null

  const existing = await prisma.scheduledTask.findUnique({ where: { id: (await params).id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await assertCanModify(caller, isService, existing.createdBy)

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

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const caller = await requireServiceAuth(req)
  const isService = caller === null

  const existing = await prisma.scheduledTask.findUnique({ where: { id: (await params).id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await assertCanModify(caller, isService, existing.createdBy)

  await prisma.scheduledTask.delete({ where: { id: (await params).id } })
  return NextResponse.json({ ok: true })
}
