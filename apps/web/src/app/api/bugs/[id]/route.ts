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
  const parsed = await parseBodyOrError(req, UpdateBugSchema)
  if ('error' in parsed) return parsed.error
  const { data } = parsed

  const updateData: Record<string, unknown> = {}
  if (data.title          !== undefined) updateData.title          = data.title
  if (data.description    !== undefined) updateData.description    = data.description
  if (data.severity       !== undefined) updateData.severity       = data.severity
  if (data.status         !== undefined) updateData.status         = data.status
  if ('area'              in data)       updateData.area           = data.area ?? null
  if ('assignedUserId'    in data) {
    const uid = data.assignedUserId ?? null
    if (uid) {
      // Validate FK before Prisma throws a P2003
      const userExists = await prisma.user.findUnique({ where: { id: uid }, select: { id: true } })
      if (!userExists) return NextResponse.json({ error: 'assignedUserId not found' }, { status: 400 })
    }
    updateData.assignedUserId = uid
  }

  const bug = await prisma.bug.update({
    where: { id: params.id },
    data: updateData,
    include: { assignedUser: { select: { id: true, name: true, username: true, email: true, role: true } } },
  })
  return NextResponse.json(bug)
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  await requireServiceAuth(req)
  await prisma.bug.delete({ where: { id: params.id } })
  return new NextResponse(null, { status: 204 })
}
