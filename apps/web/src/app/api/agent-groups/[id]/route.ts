import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
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
  await prisma.agentGroup.delete({ where: { id: params.id } })
  return new NextResponse(null, { status: 204 })
}
