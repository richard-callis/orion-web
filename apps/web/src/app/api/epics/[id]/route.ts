import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const epic = await prisma.epic.findUnique({
    where: { id: params.id },
    include: { features: { include: { _count: { select: { tasks: true } } } } },
  })
  if (!epic) return new NextResponse(null, { status: 404 })
  return NextResponse.json(epic)
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  const data: Record<string, unknown> = {}
  if (body.title       !== undefined) data.title       = body.title
  if (body.description !== undefined) data.description = body.description
  if (body.plan        !== undefined) data.plan        = body.plan
  if (body.status      !== undefined) data.status      = body.status
  const epic = await prisma.epic.update({ where: { id: params.id }, data })
  return NextResponse.json(epic)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await prisma.epic.delete({ where: { id: params.id } })
  return new NextResponse(null, { status: 204 })
}
