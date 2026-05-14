import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { ids }: { ids: string[] } = body

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: 'ids array required' }, { status: 400 })
  }

  const acknowledgedAt = new Date()

  await prisma.securityEvent.updateMany({
    where: { id: { in: ids } },
    data: { acknowledged: true, acknowledgedAt },
  })

  return NextResponse.json({ acknowledged: ids.length })
}
