import { NextRequest, NextResponse } from 'next/server'
import { requireGatewayAuthForEnvironment } from '@/lib/auth'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * GET /api/environments/[id]/nebula/active
 * Only active (installed+enabled) nebula entries — for gateway consumption.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  await requireGatewayAuthForEnvironment(req, id).catch(() => { throw Object.assign(new Error('Unauthorized'), {status:401}) })

  const entries = await prisma.nebulaInstance.findMany({
    where: { environmentId: (await params).id, isInstalled: true },
    orderBy: { name: 'asc' },
  })
  return NextResponse.json(entries)
}
