/**
 * GET /api/monitoring/security/incidents
 *
 * List security incidents with optional filters.
 * Query params: status (open|triaged|contained|closed), severity (min), search (attackerKey)
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const querySchema = z.object({
  status: z.enum(['open', 'triaged', 'contained', 'closed']).optional(),
  severity: z.coerce.number().min(0).max(100).optional(),
  search: z.string().optional(),
})

export async function GET(req: NextRequest) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid query params' }, { status: 400 })
  }

  const { status, severity, search } = parsed.data
  const envId = req.nextUrl.searchParams.get('env') || process.env.ENVIRONMENT_ID || ''

  const where: Record<string, unknown> = {}
  if (envId) where.environmentId = envId
  if (status) where.status = status
  if (severity) where.severity = { gte: severity }
  if (search) where.attackerKey = { contains: search, mode: 'insensitive' }

  const [incidents, total] = await Promise.all([
    prisma.incident.findMany({
      where,
      orderBy: { openedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        status: true,
        severity: true,
        rootCauseSummary: true,
        attackerKey: true,
        hostKey: true,
        openedAt: true,
        closedAt: true,
        _count: {
          select: {
            events: true,
            actionAudits: true,
          },
        },
      },
    }),
    prisma.incident.count({ where }),
  ])

  return NextResponse.json({
    incidents: incidents.map(i => ({
      ...i,
      eventCount: i._count.events,
      actionCount: i._count.actionAudits,
    })),
    total,
  })
}
