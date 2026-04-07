import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

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
  const body = await req.json()
  const data: Record<string, unknown> = {}
  if (body.name        !== undefined) data.name        = body.name
  if (body.role        !== undefined) data.role        = body.role
  if (body.description !== undefined) data.description = body.description
  if (body.status      !== undefined) data.status      = body.status
  if (body.metadata !== undefined) {
    // Deep merge metadata so callers can update contextConfig without wiping systemPrompt
    const existing = await prisma.agent.findUnique({ where: { id: params.id }, select: { metadata: true } })
    const existingMeta = (existing?.metadata ?? {}) as Record<string, unknown>
    data.metadata = { ...existingMeta, ...body.metadata }
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
