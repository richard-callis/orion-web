import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'
import { parseBodyOrError, CreateBugSchema } from '@/lib/validate'

export async function GET(req: NextRequest) {
  await requireServiceAuth(req)
  const bugs = await prisma.bug.findMany({
    orderBy: { updatedAt: 'desc' },
    include: { assignedUser: { select: { id: true, name: true, username: true, email: true, role: true } } },
  })
  return NextResponse.json(bugs)
}

export async function POST(req: NextRequest) {
  await requireServiceAuth(req)
  const result = await parseBodyOrError(req, CreateBugSchema)
  if ('error' in result) return result.error
  const { data } = result

  const bug = await prisma.bug.create({
    data: {
      title:          data.title,
      description:    data.description    ?? null,
      severity:       data.severity       ?? 'medium',
      status:         data.status         ?? 'open',
      area:           data.area           ?? null,
      reportedBy:     data.reportedBy     ?? 'admin',
      assignedUserId: data.assignedUserId ?? null,
    },
    include: { assignedUser: { select: { id: true, name: true, username: true, email: true, role: true } } },
  })
  return NextResponse.json(bug, { status: 201 })
}
