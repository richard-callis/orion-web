import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'
import { parseBodyOrError, UpdateBugSchema } from '@/lib/validate'

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
  const result = await parseBodyOrError(req, UpdateBugSchema)
  if ('error' in result) return result.error
  const { data } = result

  const bug = await prisma.bug.update({
    where: { id: params.id },
    data: {
      ...(data.title          !== undefined && { title: data.title }),
      ...(data.description    !== undefined && { description: data.description }),
      ...(data.severity       !== undefined && { severity: data.severity }),
      ...(data.status         !== undefined && { status: data.status }),
      ...(data.area           !== undefined && { area: data.area ?? null }),
      ...(data.assignedUserId !== undefined && { assignedUserId: data.assignedUserId ?? null }),
    },
    include: { assignedUser: { select: { id: true, name: true, username: true, email: true, role: true } } },
  })
  return NextResponse.json(bug)
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  await requireServiceAuth(req)
  await prisma.bug.delete({ where: { id: params.id } })
  return new NextResponse(null, { status: 204 })
}
