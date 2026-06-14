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
  { params }: { params: Promise<{ id: string; name: string }> }
) {
  const entry = await prisma.nebulaInstance.findFirst({
    where: { environmentId: (await params).id, name: (await params).name },
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
  { params }: { params: Promise<{ id: string; name: string }> }
) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await requireOperator(user.id, (await params).id, user.role))) {
    return NextResponse.json({ error: 'Operator access required' }, { status: 403 })
  }
  const body = await req.json()
  const existing = await prisma.nebulaInstance.findFirst({
    where: { environmentId: (await params).id, name: (await params).name },
  })
  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  // BLOCKER fix: `{ ...body, isForked: true }` spread raw body into Prisma update,
  // allowing caller to overwrite environmentId (move instance to another env),
  // sourceNovaId, category, isInstalled, etc. Whitelist allowed fields only.
  const updateData: Record<string, unknown> = { isForked: true }
  if (body.spec !== undefined)        updateData.spec = typeof body.spec === 'string' ? body.spec : JSON.stringify(body.spec)
  if (body.minimumTier !== undefined) updateData.minimumTier = String(body.minimumTier)
  if (body.category !== undefined && ['skill', 'hook'].includes(body.category)) updateData.category = body.category
  if (body.isInstalled !== undefined) updateData.isInstalled = Boolean(body.isInstalled)

  const entry = await prisma.nebulaInstance.update({
    where: { id: existing.id },
    data: updateData,
  })
  return NextResponse.json(entry)
}

/**
 * DELETE /api/environments/[id]/nebula/[name]
 * Remove a nebula entry from this environment (operator+ or admin).
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; name: string }> }
) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await requireOperator(user.id, (await params).id, user.role))) {
    return NextResponse.json({ error: 'Operator access required' }, { status: 403 })
  }
  await prisma.nebulaInstance.deleteMany({
    where: { environmentId: (await params).id, name: (await params).name },
  })
  return NextResponse.json({ ok: true })
}
