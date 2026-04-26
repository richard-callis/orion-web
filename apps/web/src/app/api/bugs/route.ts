import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
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

  // Validate bug input
  const parsed = z.object({
    title: z.string().min(1).max(500),
    description: z.string().max(10000).optional(),
    severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    status: z.enum(['open', 'in_progress', 'resolved', 'wont_fix']).optional(),
    area: z.string().max(100).optional(),
    reportedBy: z.string().max(200).optional(),
    assignedUserId: z.string().max(100).optional(),
  }).safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const bug = await prisma.bug.create({
    data: {
      title:          parsed.data.title,
      description:    parsed.data.description ?? null,
      severity:       parsed.data.severity    ?? 'medium',
      status:         parsed.data.status      ?? 'open',
      area:           parsed.data.area        ?? null,
      reportedBy:     parsed.data.reportedBy  ?? 'admin',
      assignedUserId: parsed.data.assignedUserId ?? null,
    },
    include: { assignedUser: { select: { id: true, name: true, username: true, email: true, role: true } } },
  })
  return NextResponse.json(bug, { status: 201 })
}
