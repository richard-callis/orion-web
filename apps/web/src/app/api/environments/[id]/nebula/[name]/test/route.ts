import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * POST /api/environments/[id]/nebula/[name]/test
 * Dry-run test for a hook nebula entry (hooks only).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; name: string } }
) {
  const isAdmin = req.headers.get('x-admin') === 'true'
  if (!isAdmin) {
    return NextResponse.json(
      { error: 'Operator access required' },
      { status: 403 }
    )
  }
  const body = await req.json()
  const entry = await prisma.nebulaInstance.findFirst({
    where: { environmentId: params.id, name: params.name },
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
