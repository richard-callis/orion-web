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
    take: 200,
  })
  return NextResponse.json(groups)
}

export async function POST(req: NextRequest) {
  await requireAdmin()
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const b = body as { name?: string; description?: string | null; minimumTier?: string; environmentId?: string }
  if (!b.name?.trim()) return NextResponse.json({ error: 'name required' }, { status: 400 })
  const VALID_TIERS = ['viewer', 'editor', 'admin']
  if (b.minimumTier !== undefined && !VALID_TIERS.includes(b.minimumTier)) {
    return NextResponse.json({ error: `minimumTier must be one of: ${VALID_TIERS.join(', ')}` }, { status: 400 })
  }
  if (b.environmentId) {
    const envExists = await prisma.environment.findUnique({ where: { id: b.environmentId }, select: { id: true } })
    if (!envExists) return NextResponse.json({ error: 'Environment not found' }, { status: 404 })
  }
  const group = await prisma.agentGroup.create({
    data: { name: b.name.trim(), description: b.description ?? null },
    include: {
      members:    { include: { agent: true } },
      toolAccess: { include: { toolGroup: { include: { environment: { select: { id: true, name: true } } } } } },
    },
  })
  return NextResponse.json(group, { status: 201 })
}
