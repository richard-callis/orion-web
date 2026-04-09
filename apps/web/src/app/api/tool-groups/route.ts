import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(req: NextRequest) {
  const envId = req.nextUrl.searchParams.get('environmentId')
  const groups = await prisma.toolGroup.findMany({
    where: envId ? { environmentId: envId } : undefined,
    include: {
      tools:      { include: { tool: true } },
      agentAccess: { include: { agentGroup: true } },
    },
    orderBy: { name: 'asc' },
  })
  return NextResponse.json(groups)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  if (!body.name?.trim())        return NextResponse.json({ error: 'name required' }, { status: 400 })
  if (!body.environmentId)       return NextResponse.json({ error: 'environmentId required' }, { status: 400 })
  const group = await prisma.toolGroup.create({
    data: {
      name:          body.name.trim(),
      description:   body.description ?? null,
      environmentId: body.environmentId,
      minimumTier:   body.minimumTier ?? 'viewer',
    },
    include: { tools: { include: { tool: true } }, agentAccess: { include: { agentGroup: true } } },
  })
  return NextResponse.json(group, { status: 201 })
}
