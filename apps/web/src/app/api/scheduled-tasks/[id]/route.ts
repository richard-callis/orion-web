import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'
import { parseCron, nextRun } from '@/lib/cron'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  await requireServiceAuth(req)

  const task = await prisma.scheduledTask.findUnique({
    where: { id: params.id },
    include: { agent: { select: { id: true, name: true } } },
  })

  if (!task) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(task)
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  await requireServiceAuth(req)

  const existing = await prisma.scheduledTask.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

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
    where: { id: params.id },
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

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  await requireServiceAuth(req)

  const existing = await prisma.scheduledTask.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await prisma.scheduledTask.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
