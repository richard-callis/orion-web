import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  await requireServiceAuth(req)

  const runs = await prisma.evalRun.findMany({
    where: { suiteId: params.id },
    orderBy: { createdAt: 'desc' },
    include: {
      agent: { select: { id: true, name: true } },
      _count: { select: { results: true } },
    },
  })

  return NextResponse.json(runs)
}
