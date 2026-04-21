import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

/**
 * GET /api/novas/[id]/revisions — List revisions for a Nova
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const nova = await prisma.nova.findUnique({
    where: { id: params.id },
    include: {
      revisions: {
        orderBy: { createdAt: 'desc' },
      },
    },
  })

  if (!nova) {
    return NextResponse.json({ error: 'Nova not found' }, { status: 404 })
  }

  return NextResponse.json({
    revisions: nova.revisions,
  })
}
