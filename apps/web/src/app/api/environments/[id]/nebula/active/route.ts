import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * GET /api/environments/[id]/nebula/active
 * Only active (installed+enabled) nebula entries — for gateway consumption.
 */
export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const entries = await prisma.nebulaInstance.findMany({
    where: { environmentId: params.id, isInstalled: true },
    orderBy: { name: 'asc' },
  })
  return NextResponse.json(entries)
}
