import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const g = await prisma.toolGroup.findUnique({
    where: { id: params.id },
    include: { tools: { include: { tool: true } }, agentAccess: { include: { agentGroup: true } } },
  })
  if (!g) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(g)
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  const g = await prisma.toolGroup.update({
    where: { id: params.id },
    data: {
      ...(body.name        !== undefined && { name:        body.name.trim() }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.minimumTier !== undefined && { minimumTier: body.minimumTier }),
    },
    include: { tools: { include: { tool: true } }, agentAccess: { include: { agentGroup: true } } },
  })
  return NextResponse.json(g)
}

export async function DELETE(_: NextRequest, { params }: { params: { id: string } }) {
  await prisma.toolGroup.delete({ where: { id: params.id } })
  return new NextResponse(null, { status: 204 })
}
