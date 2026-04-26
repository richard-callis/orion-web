import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { parseBodyOrError, UpdateAgentSchema } from '@/lib/validate'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
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
  // SOC2 [INPUT-001]: Validate request body with Zod schema
  const result = await parseBodyOrError(req, UpdateAgentSchema)
  if ('error' in result) return result.error

  const { data: validatedData } = result
  const data: Record<string, unknown> = {}
  if (validatedData.name        !== undefined) data.name        = validatedData.name
  if (validatedData.type        !== undefined) data.type        = validatedData.type
  if (validatedData.role        !== undefined) data.role        = validatedData.role
  if (validatedData.metadata !== undefined) {
    // Deep merge metadata so callers can update contextConfig without wiping systemPrompt
    const existing = await prisma.agent.findUnique({ where: { id: params.id }, select: { metadata: true } })
    const existingMeta = (existing?.metadata ?? {}) as Record<string, unknown>
    data.metadata = { ...existingMeta, ...validatedData.metadata }
  }
  const agent = await prisma.agent.update({ where: { id: params.id }, data })
  return NextResponse.json(agent)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  // Unassign tasks first to avoid FK violation
  await prisma.task.updateMany({ where: { assignedAgent: params.id }, data: { assignedAgent: null } })
  await prisma.agent.delete({ where: { id: params.id } })
  return new NextResponse(null, { status: 204 })
}
