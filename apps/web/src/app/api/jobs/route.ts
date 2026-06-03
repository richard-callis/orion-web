import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export async function GET(req: NextRequest) {
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { searchParams } = new URL(req.url)
  const includeArchived = searchParams.get('archived') === 'true'

  const jobs = await prisma.backgroundJob.findMany({
    where: includeArchived ? {} : { archivedAt: null },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  return NextResponse.json(jobs)
}
