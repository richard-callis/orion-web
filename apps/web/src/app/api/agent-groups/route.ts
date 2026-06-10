import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export async function GET() {
  const users = await requireAdmin()
  void users // admin check passed
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
  await requireAdmin()
  const body = await req.json()
  if (!body.name?.trim()) return NextResponse.json({ error: 'name required' }, { status: 400 })
  const VALID_TIERS = ['viewer', 'editor', 'admin']
  if (body.minimumTier !== undefined && !VALID_TIERS.includes(body.minimumTier)) {
    return NextResponse.json({ error: `minimumTier must be one of: ${VALID_TIERS.join(', ')}` }, { status: 400 })
  }
  if (body.environmentId) {
    const envExists = await prisma.environment.findUnique({ where: { id: body.environmentId }, select: { id: true } })
    if (!envExists) return NextResponse.json({ error: 'Environment not found' }, { status: 404 })
  }
  const group = await prisma.agentGroup.create({
    data: { name: body.name.trim(), description: body.description ?? null },
    include: {
      members:    { include: { agent: true } },
      toolAccess: { include: { toolGroup: { include: { environment: { select: { id: true, name: true } } } } } },
    },
  })
  return NextResponse.json(group, { status: 201 })
}
