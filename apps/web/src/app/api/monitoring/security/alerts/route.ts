import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const { searchParams } = new URL(request.url)
  const type = searchParams.get('type') || undefined
  const severityParam = searchParams.get('severity')
  const severity = severityParam ? parseInt(severityParam) : undefined
  const minutes = searchParams.get('minutes') ? parseInt(searchParams.get('minutes')!) : 60
  const from = searchParams.get('from') || undefined
  const to = searchParams.get('to') || undefined
  const page = searchParams.get('page') ? parseInt(searchParams.get('page')!) : 1
  const limit = Math.min(searchParams.get('limit') ? parseInt(searchParams.get('limit')!) : 50, 200)

  // source: comma-separated list (e.g. "crowdsec,falco")
  const sourceParam = searchParams.get('source')
  const sources = sourceParam ? sourceParam.split(',').map(s => s.trim()).filter(Boolean) : []

  // acknowledged: 'true' → acked only, 'false' → unacked only, absent → all
  const ackParam = searchParams.get('acknowledged')
  const acknowledged = ackParam === 'true' ? true : ackParam === 'false' ? false : undefined

  const envId = process.env.ENVIRONMENT_ID || ''

  const where: Record<string, unknown> = {}
  if (envId) where.environmentId = envId
  if (type) where.type = type
  if (severity != null) where.severity = { gte: severity }
  if (acknowledged !== undefined) where.acknowledged = acknowledged
  if (sources.length === 1) where.source = sources[0]
  if (sources.length > 1) where.source = { in: sources }

  // Prefer absolute from/to over relative minutes
  if (from || to) {
    const dateFilter: Record<string, unknown> = {}
    if (from) dateFilter.gte = new Date(from)
    if (to) dateFilter.lte = new Date(to)
    where.createdAt = dateFilter
  } else {
    where.createdAt = { gte: new Date(Date.now() - minutes * 60 * 1000) }
  }

  const [events, total] = await Promise.all([
    prisma.securityEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.securityEvent.count({ where }),
  ])

  return NextResponse.json({
    events: events.map(a => ({
      id: a.id,
      type: a.type,
      source: a.source,
      severity: a.severity,
      title: a.title,
      description: a.description,
      acknowledged: a.acknowledged,
      acknowledgedAt: a.acknowledgedAt,
      createdAt: a.createdAt,
    })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  })
}
