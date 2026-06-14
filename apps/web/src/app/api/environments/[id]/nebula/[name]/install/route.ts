import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * POST /api/environments/[id]/nebula/[name]/install
 * Install a default nebula from its NovaDefinition into the given environment.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; name: string }> }
) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const tier = await prisma.environmentUserTier.findUnique({
    where: { userId_environmentId: { userId: user.id, environmentId: (await params).id } },
  })
  const effectiveTier = user.role === 'admin' ? 'admin' : (tier?.tier ?? 'viewer')
  if (!['operator', 'admin'].includes(effectiveTier)) {
    return NextResponse.json(
      { error: 'Operator access required' },
      { status: 403 }
    )
  }
  const def = await prisma.novaDefinition.findFirst({
    where: { name: (await params).name },
  })
  if (!def) {
    return NextResponse.json(
      { error: 'Definition not found' },
      { status: 404 }
    )
  }
  const existing = await prisma.nebulaInstance.findFirst({
    where: { environmentId: (await params).id, name: (await params).name },
  })
  if (existing) {
    return NextResponse.json(
      { error: 'Already installed' },
      { status: 409 }
    )
  }
  const entry = await prisma.nebulaInstance.create({
    data: {
      environmentId: (await params).id,
      name: def.name,
      category: def.category,
      spec: def.spec,
      sourceNovaId: def.id,
    },
  })
  return NextResponse.json(entry)
}
