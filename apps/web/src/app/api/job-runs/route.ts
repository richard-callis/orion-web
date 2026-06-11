import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try { await requireServiceAuth(req) } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const { searchParams } = new URL(req.url)
  const limit  = Math.min(parseInt(searchParams.get('limit') ?? '200', 10), 500)
  const source = searchParams.get('source') ?? undefined

  const runs = await prisma.jobRun.findMany({
    where:   source ? { source } : undefined,
    orderBy: { startedAt: 'desc' },
    take:    limit,
  })

  return NextResponse.json(runs)
}
