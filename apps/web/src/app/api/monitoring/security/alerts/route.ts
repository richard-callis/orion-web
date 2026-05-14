import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const type = searchParams.get('type') || undefined
  const severity = searchParams.get('severity') ? parseInt(searchParams.get('severity')!) : undefined
  const minutes = searchParams.get('minutes') ? parseInt(searchParams.get('minutes')!) : 60
  const acknowledged = searchParams.get('acknowledged') === 'true'
  const page = searchParams.get('page') ? parseInt(searchParams.get('page')!) : 1
  const limit = searchParams.get('limit') ? parseInt(searchParams.get('limit')!) : 20

  const envId = process.env.ENVIRONMENT_ID || ''

  const where: Record<string, unknown> = {}
  if (envId) where.environmentId = envId
  if (type) where.type = type
  if (severity) where.severity = { gte: severity }
  if (typeof acknowledged === 'boolean') where.acknowledged = acknowledged

  const cutoff = new Date(Date.now() - minutes * 60 * 1000)
  const existingCreatedAt = (where.createdAt ?? {}) as Record<string, unknown>
  where.createdAt = { ...existingCreatedAt, gte: cutoff }

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
