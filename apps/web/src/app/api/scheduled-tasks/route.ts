import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth, assertCanModify } from '@/lib/auth'
import { parseCron, nextRun } from '@/lib/cron'

export async function GET(req: NextRequest) {
  await requireServiceAuth(req)

  const tasks = await prisma.scheduledTask.findMany({
    orderBy: { createdAt: 'desc' },
    include: { agent: { select: { id: true, name: true } } },
  })

  return NextResponse.json(tasks)
}

export async function POST(req: NextRequest) {
  const caller = await requireServiceAuth(req)
  const isService = caller === null

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { name, agentId, cronExpr, taskTitle, taskDesc, enabled } = body as Record<string, unknown>

  if (!name || typeof name !== 'string') return NextResponse.json({ error: 'name is required' }, { status: 400 })
  if (!agentId || typeof agentId !== 'string') return NextResponse.json({ error: 'agentId is required' }, { status: 400 })
  if (!cronExpr || typeof cronExpr !== 'string') return NextResponse.json({ error: 'cronExpr is required' }, { status: 400 })
  if (!taskTitle || typeof taskTitle !== 'string') return NextResponse.json({ error: 'taskTitle is required' }, { status: 400 })

  if (!parseCron(cronExpr)) {
    return NextResponse.json({ error: `Invalid cron expression: "${cronExpr}"` }, { status: 400 })
  }

  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { id: true, createdBy: true } })
  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

  // SOC2 [PRIV-003]: Verify caller owns (or is admin/service for) the target agent
  try {
    await assertCanModify(caller, isService, agent.createdBy)
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const initialNextRun = nextRun(cronExpr)

  const task = await prisma.scheduledTask.create({
    data: {
      name,
      agentId,
      cronExpr,
      taskTitle,
      taskDesc: typeof taskDesc === 'string' ? taskDesc : null,
      enabled:  enabled !== false,
      nextRunAt: initialNextRun,
    },
    include: { agent: { select: { id: true, name: true } } },
  })

  return NextResponse.json(task, { status: 201 })
}
