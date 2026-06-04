import { NextRequest } from "next/server"
import { NextResponse } from 'next/server'
import { requireServiceAuth } from '@/lib/auth'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * GET /api/environments/[id]/nebula/[name]/skill-logs
 * Retrieve skill execution logs for a nebula entry.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; name: string } }
) {
  await requireServiceAuth(req).catch(() => { throw Object.assign(new Error('Unauthorized'), {status:401}) })

  const logs = await prisma.skillExecutionLog.findMany({
    where: { nebula: { environmentId: params.id, name: params.name } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  return NextResponse.json(logs)
}
