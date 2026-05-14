import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * GET /api/environments/[id]/nebula/[name]/skill-logs
 * Retrieve skill execution logs for a nebula entry.
 */
export async function GET(
  _req: Request,
  { params }: { params: { id: string; name: string } }
) {
  const logs = await prisma.skillExecutionLog.findMany({
    where: { nebula: { environmentId: params.id, name: params.name } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  return NextResponse.json(logs)
}
