import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const g = await prisma.toolGroup.findUnique({
    where: { id: params.id },
    include: { tools: { include: { tool: true } }, agentAccess: { include: { agentGroup: true } } },
  })
  if (!g) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(g)
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const b = body as { name?: string; description?: string | null; minimumTier?: string }
  const g = await prisma.toolGroup.update({
    where: { id: params.id },
    data: {
      ...(b.name        !== undefined && { name:        b.name.trim() }),
      ...(b.description !== undefined && { description: b.description }),
      ...(b.minimumTier !== undefined && { minimumTier: b.minimumTier }),
    },
    include: { tools: { include: { tool: true } }, agentAccess: { include: { agentGroup: true } } },
  })
  return NextResponse.json(g)
}

export async function DELETE(_: NextRequest, { params }: { params: { id: string } }) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  await prisma.toolGroup.delete({ where: { id: params.id } })
  return new NextResponse(null, { status: 204 })
}
