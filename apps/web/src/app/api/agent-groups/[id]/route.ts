import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  await requireAdmin()
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const b = body as { name?: unknown; description?: unknown }
  if (b.name !== undefined && (!b.name || typeof b.name !== 'string' || !b.name.trim())) {
    return NextResponse.json({ error: 'name must be a non-empty string' }, { status: 400 })
  }
  const g = await prisma.agentGroup.update({
    where: { id: params.id },
    data: {
      ...(b.name        !== undefined && { name:        (b.name as string).trim() }),
      ...(b.description !== undefined && { description: b.description as string | null }),
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
