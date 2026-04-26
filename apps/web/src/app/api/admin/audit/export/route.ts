import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/audit/export
 *
 * Export audit logs in CSV or JSON format with optional filtering.
 * SOC2: [M-005] Auditor-facing export capability.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin()
  const params = req.nextUrl.searchParams

  const action = params.get('action') ?? undefined
  const userId = params.get('userId') ?? undefined
  const from = params.get('from') ? new Date(params.get('from')!) : undefined
  const to = params.get('to') ? new Date(params.get('to')!) : undefined
  const format = (params.get('format') ?? 'json') as 'json' | 'csv'
  const limitRaw = parseInt(params.get('limit') ?? '1000', 10)
  const limit = Math.min(Math.max(limitRaw, 1), 10000)

  const where: Record<string, unknown> = {}
  if (action) where.action = action
  if (userId) where.userId = userId
  if (from || to) {
    where.createdAt = {}
    if (from) (where.createdAt as any).gte = from
    if (to) (where.createdAt as any).lte = to
  }

  const entries = await prisma.auditLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
  })

  if (format === 'csv') {
    const headers = ['timestamp', 'userId', 'action', 'target', 'ipAddress', 'userAgent']
    const csvRows = [
      headers.join(','),
      ...entries.map(e =>
        [
          e.createdAt.toISOString(),
          csvEscape(e.userId ?? ''),
          csvEscape(e.action),
          csvEscape(e.target ?? ''),
          csvEscape(e.ipAddress ?? ''),
          csvEscape(e.userAgent ?? ''),
        ].join(',')
      ),
    ].join('\n')

    return new NextResponse(csvRows, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="audit-log-${new Date().toISOString().split('T')[0]}.csv"`,
      },
    })
  }

  // JSON format (default)
  return NextResponse.json(
    { count: entries.length, entries: entries.map(e => ({
      id: e.id,
      timestamp: e.createdAt.toISOString(),
      userId: e.userId,
      action: e.action,
      target: e.target,
      detail: e.detail,
      ipAddress: e.ipAddress,
      userAgent: e.userAgent,
    })) },
    {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="audit-log-${new Date().toISOString().split('T')[0]}.json"`,
      },
    },
  )
}

function csvEscape(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return `"${val.replace(/"/g, '""')}"`
  }
  return val
}
