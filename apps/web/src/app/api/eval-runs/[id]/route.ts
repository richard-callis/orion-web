import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  await requireServiceAuth(req)

  const run = await prisma.evalRun.findUnique({
    where: { id: params.id },
    include: {
      suite: { select: { id: true, name: true } },
      agent: { select: { id: true, name: true } },
      results: {
        include: {
          case: { select: { id: true, title: true, prompt: true, expectedOutput: true, weight: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  })

  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(run)
}
