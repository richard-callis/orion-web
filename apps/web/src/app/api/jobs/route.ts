import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const includeArchived = searchParams.get('archived') === 'true'

  const jobs = await prisma.backgroundJob.findMany({
    where: includeArchived ? {} : { archivedAt: null },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  return NextResponse.json(jobs)
}
