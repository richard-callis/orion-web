import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { parseBodyOrError, UpdateAgentSchema } from '@/lib/validate'
import { requireAdmin, requireAuth, assertCanModify } from '@/lib/auth'
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'

/**
 * Map an assertCanModify rejection to the right HTTP status.
 * Returns null when access is allowed.
 */
async function guardAccess(
  caller: Awaited<ReturnType<typeof requireAuth>> | null,
  recordCreatedBy: string | null,
): Promise<NextResponse | null> {
  // Null createdBy = shared/system agent. Only admins may modify these.
  if (recordCreatedBy === null) {
    try { await requireAdmin() } catch {
      return new NextResponse(null, { status: 403 })
    }
    return null
  }
  try {
    await assertCanModify(caller, /* isService */ false, recordCreatedBy)
    return null
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (msg === 'Forbidden') return new NextResponse(null, { status: 403 })
    return new NextResponse(null, { status: 401 })
  }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const agent = await prisma.agent.findUnique({
    where: { id: (await params).id },
    include: {
      tasks: { orderBy: { updatedAt: 'desc' }, take: 20 },
      messages: { orderBy: { createdAt: 'desc' }, take: 10 },
    },
  })
  if (!agent) return new NextResponse(null, { status: 404 })
  return NextResponse.json(agent)
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Require authenticated user; admin or creator may modify.
  let caller
  try { caller = await requireAuth() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const existing = await prisma.agent.findUnique({ where: { id: (await params).id }, select: { createdBy: true, metadata: true } })
  if (!existing) return new NextResponse(null, { status: 404 })

  const denied = await guardAccess(caller, existing.createdBy ?? null)
  if (denied) return denied

  // SOC2 [INPUT-001]: Validate request body with Zod schema
  const result = await parseBodyOrError(req, UpdateAgentSchema)
  if ('error' in result) return result.error

  const { data: validatedData } = result
  const data: Record<string, unknown> = {}
  if (validatedData.name        !== undefined) data.name        = validatedData.name
  if (validatedData.type        !== undefined) data.type        = validatedData.type
  if (validatedData.role        !== undefined) data.role        = validatedData.role
  if (validatedData.tokenBudgetDay   !== undefined) data.tokenBudgetDay   = validatedData.tokenBudgetDay
  if (validatedData.tokenBudgetMonth !== undefined) data.tokenBudgetMonth = validatedData.tokenBudgetMonth
  if (validatedData.metadata !== undefined) {
    // Deep merge metadata so callers can update contextConfig without wiping systemPrompt
    const existingMeta = (existing?.metadata ?? {}) as Record<string, unknown>
    data.metadata = { ...existingMeta, ...validatedData.metadata }
  }
  const agent = await prisma.agent.update({ where: { id: (await params).id }, data })
  return NextResponse.json(agent)
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let caller
  try { caller = await requireAuth() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const agent = await prisma.agent.findUnique({ where: { id: (await params).id }, select: { name: true, createdBy: true } })
  if (!agent) return new NextResponse(null, { status: 404 })

  const denied = await guardAccess(caller, agent.createdBy ?? null)
  if (denied) return denied

  // Unassign tasks first to avoid FK violation
  await prisma.task.updateMany({ where: { assignedAgent: (await params).id }, data: { assignedAgent: null } })
  await prisma.agent.delete({ where: { id: (await params).id } })

  // SOC2: audit agent deletion
  logAudit({
    userId: caller.id,
    action: 'agent_delete',
    target: `agent:${(await params).id}`,
    detail: { name: agent?.name },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req.headers),
  }).catch(() => {})

  return new NextResponse(null, { status: 204 })
}
