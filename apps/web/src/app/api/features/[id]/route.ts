import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const feature = await prisma.feature.findUnique({
    where: { id: params.id },
    include: { _count: { select: { tasks: true } } },
  })
  if (!feature) return new NextResponse(null, { status: 404 })
  return NextResponse.json(feature)
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  const data: Record<string, unknown> = {}
  if (body.title       !== undefined) data.title       = body.title
  if (body.description !== undefined) data.description = body.description
  if (body.plan        !== undefined) data.plan        = body.plan
  if (body.status      !== undefined) data.status      = body.status
  const feature = await prisma.feature.update({ where: { id: params.id }, data })
  return NextResponse.json(feature)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await prisma.feature.delete({ where: { id: params.id } })
  return new NextResponse(null, { status: 204 })
}
