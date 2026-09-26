import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth, requireWriteAccess } from '@/lib/auth'
import { parseCron, nextRun, minCronIntervalSeconds } from '@/lib/cron'
import { isSystemAgent } from '@/lib/scheduled-task-access'

export async function GET(req: NextRequest) {
  try {
    await requireServiceAuth(req)
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const tasks = await prisma.scheduledTask.findMany({
    orderBy: { createdAt: 'desc' },
    include: { agent: { select: { id: true, name: true } } },
  })

  return NextResponse.json(tasks)
}

export async function POST(req: NextRequest) {
  // SOC2 [H4]: schedules spawn agent tasks on a timer — human sessions with write
  // access only (no readonly users, no gateway token), and the creator owns the row.
  let caller
  try {
    caller = await requireWriteAccess()
  } catch (e) {
    const status = e instanceof Error && e.message === 'Forbidden' ? 403 : 401
    return NextResponse.json({ error: status === 403 ? 'Forbidden' : 'Unauthorized' }, { status })
  }

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

  // SOC2 [M-009]: Enforce a minimum cron interval of 5 minutes to prevent
  // resource exhaustion from high-frequency scheduled tasks (e.g. "* * * * *").
  const MIN_CRON_INTERVAL_SECONDS = 300
  const intervalSecs = minCronIntervalSeconds(cronExpr)
  if (intervalSecs < MIN_CRON_INTERVAL_SECONDS) {
    return NextResponse.json(
      {
        error: `Cron expression fires too frequently (minimum interval is 5 minutes; detected ~${Math.round(intervalSecs)}s)`,
      },
      { status: 400 },
    )
  }

  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { id: true, createdBy: true } })
  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

  // Non-admins may only schedule work for agents they can see (their own or shared),
  // and never for privileged system agents.
  if (caller.role !== 'admin') {
    if (agent.createdBy && agent.createdBy !== caller.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (await isSystemAgent(agentId)) {
      return NextResponse.json({ error: 'Only admins can schedule tasks for system agents' }, { status: 403 })
    }
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
      createdBy: caller.id,
    },
    include: { agent: { select: { id: true, name: true } } },
  })

  return NextResponse.json(task, { status: 201 })
}
