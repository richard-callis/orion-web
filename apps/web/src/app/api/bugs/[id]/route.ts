import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  await requireServiceAuth(req)
  const bug = await prisma.bug.findUnique({
    where: { id: params.id },
    include: { assignedUser: { select: { id: true, name: true, username: true, email: true, role: true } } },
  })
  if (!bug) return new NextResponse(null, { status: 404 })
  return NextResponse.json(bug)
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  await requireServiceAuth(req)
  const body = await req.json()
  const data: Record<string, unknown> = {}
  if (body.title          !== undefined) data.title          = body.title
  if (body.description    !== undefined) data.description    = body.description
  if (body.severity       !== undefined) data.severity       = body.severity
  if (body.status         !== undefined) data.status         = body.status
  if (body.area           !== undefined) data.area           = body.area || null
  if (body.assignedUserId !== undefined) data.assignedUserId = body.assignedUserId || null
  const bug = await prisma.bug.update({
    where: { id: params.id },
    data,
    include: { assignedUser: { select: { id: true, name: true, username: true, email: true, role: true } } },
  })
  return NextResponse.json(bug)
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  await requireServiceAuth(req)
  await prisma.bug.delete({ where: { id: params.id } })
  return new NextResponse(null, { status: 204 })
}
