import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'

export async function GET(req: NextRequest) {
  await requireServiceAuth(req)

  const suites = await prisma.evalSuite.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { cases: true } },
      agent: { select: { id: true, name: true } },
      runs: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { scoreTotal: true, status: true, createdAt: true },
      },
    },
  })

  return NextResponse.json(suites)
}

export async function POST(req: NextRequest) {
  await requireServiceAuth(req)

  let body: { name: string; description?: string; agentId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  const suite = await prisma.evalSuite.create({
    data: {
      name: body.name,
      description: body.description ?? null,
      agentId: body.agentId ?? null,
    },
  })

  return NextResponse.json(suite, { status: 201 })
}
