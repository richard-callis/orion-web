import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET() {
  const epics = await prisma.epic.findMany({
    orderBy: { updatedAt: 'desc' },
    include: { features: { include: { _count: { select: { tasks: true } } }, orderBy: { createdAt: 'asc' } } },
  })
  return NextResponse.json(epics)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const epic = await prisma.epic.create({
    data: { title: body.title, description: body.description ?? null, createdBy: body.createdBy ?? 'admin' },
    include: { features: { include: { _count: { select: { tasks: true } } } } },
  })
  return NextResponse.json(epic, { status: 201 })
}
