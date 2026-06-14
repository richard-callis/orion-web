import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * POST /api/environments/[id]/nebula/[name]/test
 * Dry-run test for a hook nebula entry (hooks only).
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
  const body = await req.json()
  const entry = await prisma.nebulaInstance.findFirst({
    where: { environmentId: (await params).id, name: (await params).name },
  })
  if (!entry) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const spec = JSON.parse(entry.spec) as {
    actionType?: string
    actionConfig?: unknown
  }
  // Dry run: return what would happen
  return NextResponse.json({
    dryRun: true,
    actionType: spec.actionType,
    preview: spec.actionConfig,
  })
}
