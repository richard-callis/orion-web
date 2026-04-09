import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET() {
  const groups = await prisma.agentGroup.findMany({
    include: {
      members:    { include: { agent: true } },
      toolAccess: { include: { toolGroup: { include: { environment: { select: { id: true, name: true } } } } } },
    },
    orderBy: { name: 'asc' },
  })
  return NextResponse.json(groups)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  if (!body.name?.trim()) return NextResponse.json({ error: 'name required' }, { status: 400 })
  const group = await prisma.agentGroup.create({
    data: { name: body.name.trim(), description: body.description ?? null },
    include: {
      members:    { include: { agent: true } },
      toolAccess: { include: { toolGroup: { include: { environment: { select: { id: true, name: true } } } } } },
    },
  })
  return NextResponse.json(group, { status: 201 })
}
