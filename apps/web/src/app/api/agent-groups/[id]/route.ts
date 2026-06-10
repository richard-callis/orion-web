import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  await requireAdmin()
  const body = await req.json()
  if (body.name !== undefined && (!body.name || typeof body.name !== 'string' || !body.name.trim())) {
    return NextResponse.json({ error: 'name must be a non-empty string' }, { status: 400 })
  }
  const g = await prisma.agentGroup.update({
    where: { id: params.id },
    data: {
      ...(body.name        !== undefined && { name:        body.name.trim() }),
      ...(body.description !== undefined && { description: body.description }),
    },
    include: { members: { include: { agent: true } }, toolAccess: { include: { toolGroup: true } } },
  })
  return NextResponse.json(g)
}

export async function DELETE(_: NextRequest, { params }: { params: { id: string } }) {
  await requireAdmin()
  await prisma.agentGroup.delete({ where: { id: params.id } })
  return new NextResponse(null, { status: 204 })
}
