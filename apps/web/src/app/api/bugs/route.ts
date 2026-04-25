import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'

export async function GET(req: NextRequest) {
  await requireServiceAuth(req)
  const bugs = await prisma.bug.findMany({
    orderBy: { updatedAt: 'desc' },
    include: { assignedUser: { select: { id: true, name: true, username: true, email: true, role: true } } },
  })
  return NextResponse.json(bugs)
}

export async function POST(req: NextRequest) {
  const caller = await requireServiceAuth(req)
  const isService = caller === null
  const body = await req.json()
  const bug = await prisma.bug.create({
    data: {
      title:          body.title,
      description:    body.description ?? null,
      severity:       body.severity    ?? 'medium',
      status:         body.status      ?? 'open',
      area:           body.area        ?? null,
      reportedBy:     body.reportedBy  ?? 'admin',
      assignedUserId: body.assignedUserId ?? null,
    },
    include: { assignedUser: { select: { id: true, name: true, username: true, email: true, role: true } } },
  })
  return NextResponse.json(bug, { status: 201 })
}
