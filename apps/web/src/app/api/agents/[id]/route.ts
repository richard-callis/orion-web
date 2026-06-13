import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { parseBodyOrError, UpdateAgentSchema } from '@/lib/validate'
import { requireAdmin } from '@/lib/auth'
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const agent = await prisma.agent.findUnique({
    where: { id: params.id },
    include: {
      tasks: { orderBy: { updatedAt: 'desc' }, take: 20 },
      messages: { orderBy: { createdAt: 'desc' }, take: 10 },
    },
  })
  if (!agent) return new NextResponse(null, { status: 404 })
  return NextResponse.json(agent)
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  // Require admin — any authenticated user could otherwise overwrite any agent's
  // systemPrompt or contextConfig (privilege escalation).
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Admin privileges required to modify agents' }, { status: 403 })
  }

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
    const existing = await prisma.agent.findUnique({ where: { id: params.id }, select: { metadata: true } })
    const existingMeta = (existing?.metadata ?? {}) as Record<string, unknown>
    data.metadata = { ...existingMeta, ...validatedData.metadata }
  }
  const agent = await prisma.agent.update({ where: { id: params.id }, data })
  return NextResponse.json(agent)
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  let adminUser
  try { adminUser = await requireAdmin() } catch {
    return NextResponse.json({ error: 'Admin privileges required to delete agents' }, { status: 403 })
  }

  const agent = await prisma.agent.findUnique({ where: { id: params.id }, select: { name: true } })

  // Unassign tasks first to avoid FK violation
  await prisma.task.updateMany({ where: { assignedAgent: params.id }, data: { assignedAgent: null } })
  await prisma.agent.delete({ where: { id: params.id } })

  // SOC2: audit agent deletion
  logAudit({
    userId: adminUser.id,
    action: 'agent_delete',
    target: `agent:${params.id}`,
    detail: { name: agent?.name },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req.headers),
  }).catch(() => {})

  return new NextResponse(null, { status: 204 })
}
