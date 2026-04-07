import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const epicId = searchParams.get('epicId')
  const features = await prisma.feature.findMany({
    where: epicId ? { epicId } : undefined,
    orderBy: { createdAt: 'asc' },
    include: { epic: true, _count: { select: { tasks: true } } },
  })
  return NextResponse.json(features)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const feature = await prisma.feature.create({
    data: { epicId: body.epicId, title: body.title, description: body.description ?? null, createdBy: body.createdBy ?? 'admin' },
    include: { _count: { select: { tasks: true } } },
  })
  return NextResponse.json(feature, { status: 201 })
}
