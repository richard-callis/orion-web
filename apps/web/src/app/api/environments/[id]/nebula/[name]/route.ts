import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'

export const dynamic = 'force-dynamic'

async function requireOperator(userId: string, envId: string, role: string) {
  const tier = await prisma.environmentUserTier.findUnique({
    where: { userId_environmentId: { userId, environmentId: envId } },
  })
  const effectiveTier = role === 'admin' ? 'admin' : (tier?.tier ?? 'viewer')
  return ['operator', 'admin'].includes(effectiveTier)
}

/**
 * GET /api/environments/[id]/nebula/[name]
 * Get a specific nebula instance by name.
 */
export async function GET(
  _req: Request,
  { params }: { params: { id: string; name: string } }
) {
  const entry = await prisma.nebulaInstance.findFirst({
    where: { environmentId: params.id, name: params.name },
  })
  if (!entry) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return NextResponse.json(entry)
}

/**
 * PUT /api/environments/[id]/nebula/[name]
 * Update or fork a nebula entry (operator+ or admin).
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string; name: string } }
) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await requireOperator(user.id, params.id, user.role))) {
    return NextResponse.json({ error: 'Operator access required' }, { status: 403 })
  }
  const body = await req.json()
  const existing = await prisma.nebulaInstance.findFirst({
    where: { environmentId: params.id, name: params.name },
  })
  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const entry = await prisma.nebulaInstance.update({
    where: { id: existing.id },
    data: { ...body, isForked: true },
  })
  return NextResponse.json(entry)
}

/**
 * DELETE /api/environments/[id]/nebula/[name]
 * Remove a nebula entry from this environment (operator+ or admin).
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; name: string } }
) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await requireOperator(user.id, params.id, user.role))) {
    return NextResponse.json({ error: 'Operator access required' }, { status: 403 })
  }
  await prisma.nebulaInstance.deleteMany({
    where: { environmentId: params.id, name: params.name },
  })
  return NextResponse.json({ ok: true })
}
