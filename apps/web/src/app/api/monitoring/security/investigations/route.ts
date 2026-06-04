/**
 * GET /api/monitoring/security/investigations
 * POST /api/monitoring/security/investigations
 *
 * List investigations (cursor pagination, filters) and create new ones.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const querySchema = z.object({
  status: z.enum(['open', 'active', 'suspended', 'resolved', 'closed']).optional(),
  severity: z.coerce.number().min(0).max(100).optional(),
  assignedTo: z.string().optional(),
  tags: z.string().optional(),
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
})

const createSchema = z.object({
  name: z.string().min(1),
  severity: z.number().int().min(0).max(100).optional(),
  tlp: z.enum(['white', 'green', 'amber', 'red']).default('amber'),
  pap: z.number().int().min(0).max(3).default(2),
  tags: z.array(z.string()).default([]),
  mitreAttackIds: z.array(z.string()).default([]),
  incidentId: z.string().uuid().optional(),
  createdBy: z.string().default('admin'),
})

export async function GET(req: NextRequest) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid query params' }, { status: 400 })
  }

  const { status, severity, assignedTo, tags, search, cursor, limit } = parsed.data

  const where: Record<string, unknown> = {}
  if (status) where.status = status
  if (severity) where.severity = { gte: severity }
  if (assignedTo) where.assignedTo = assignedTo
  if (tags) where.tags = { has: tags }
  if (search) where.OR = [{ name: { contains: search, mode: 'insensitive' } }]

  const cursorOpt = cursor ? { id: cursor } : undefined
  const items = await prisma.investigation.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    cursor: cursorOpt,
    select: {
      id: true, name: true, status: true, severity: true, tlp: true,
      tags: true, createdBy: true, startedAt: true, resolvedAt: true, closedAt: true,
      _count: { select: { incidents: true, notes: true, observables: true, timeline: true } },
    },
  })

  const hasMore = items.length > limit
  const data = items.slice(0, limit)
  const nextCursor = hasMore ? items[items.length - 1].id : null

  return NextResponse.json({
    investigations: data.map(i => ({
      ...i,
      incidentCount: i._count.incidents,
      noteCount: i._count.notes,
      observableCount: i._count.observables,
      timelineCount: i._count.timeline,
      _count: undefined,
    })),
    pagination: { nextCursor, hasMore },
  })
}

export async function POST(req: Request) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const body = createSchema.safeParse(await req.json())
  if (!body.success) {
    return NextResponse.json({ error: body.error.errors }, { status: 400 })
  }

  const { name, severity, tlp, pap, tags, mitreAttackIds, incidentId, createdBy } = body.data

  const investigation = await prisma.investigation.create({
    data: {
      name,
      severity: severity ?? 50,
      tlp, pap, tags, mitreAttackIds, createdBy,
    },
  })

  // Link incident if provided
  if (incidentId) {
    await prisma.incident.updateMany({
      where: { id: incidentId, investigationId: null },
      data: { investigationId: investigation.id },
    })

    await prisma.investigationTimeline.create({
      data: {
        investigationId: investigation.id,
        eventTime: new Date(),
        eventType: 'link_added',
        title: `Incident linked`,
        description: incidentId,
        source: 'manual',
      },
    })
  }

  // Initial timeline entry
  await prisma.investigationTimeline.create({
    data: {
      investigationId: investigation.id,
      eventTime: investigation.startedAt,
      eventType: 'incident_created',
      title: 'Investigation created',
      description: `Created by ${createdBy}`,
      source: createdBy === 'warden' ? 'warden' : 'manual',
    },
  })

  return NextResponse.json(investigation, { status: 201 })
}
