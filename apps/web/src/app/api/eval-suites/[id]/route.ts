import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  await requireServiceAuth(req)

  const suite = await prisma.evalSuite.findUnique({
    where: { id: params.id },
    include: {
      agent: { select: { id: true, name: true } },
      cases: { orderBy: { createdAt: 'asc' } },
      runs: {
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: {
          agent: { select: { id: true, name: true } },
          _count: { select: { results: true } },
        },
      },
    },
  })

  if (!suite) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(suite)
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  await requireServiceAuth(req)

  let body: { name?: string; description?: string; agentId?: string | null }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const suite = await prisma.evalSuite.update({
    where: { id: params.id },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.agentId !== undefined && { agentId: body.agentId }),
    },
  })

  return NextResponse.json(suite)
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  await requireServiceAuth(req)

  await prisma.evalSuite.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
