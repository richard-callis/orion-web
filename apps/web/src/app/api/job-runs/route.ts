import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
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
