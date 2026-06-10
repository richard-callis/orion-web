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
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const b = body as { name?: string; description?: string | null; environmentId?: string; minimumTier?: string }
  if (!b.name?.trim())        return NextResponse.json({ error: 'name required' }, { status: 400 })
  if (!b.environmentId)       return NextResponse.json({ error: 'environmentId required' }, { status: 400 })
  const group = await prisma.toolGroup.create({
    data: {
      name:          b.name.trim(),
      description:   b.description ?? null,
      environmentId: b.environmentId,
      minimumTier:   b.minimumTier ?? 'viewer',
    },
    include: { tools: { include: { tool: true } }, agentAccess: { include: { agentGroup: true } } },
  })
  return NextResponse.json(group, { status: 201 })
}
