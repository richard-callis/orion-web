/**
 * GET /api/monitoring/security/investigations/[id]/audit
 *
 * Audit log for an investigation (paginated).
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const id = (await params).id
  const limit = parseInt(req.nextUrl.searchParams.get('limit') ?? '25', 10)
  const cursor = req.nextUrl.searchParams.get('cursor')

  const investigation = await prisma.investigation.findUnique({ where: { id } })
  if (!investigation) {
    return NextResponse.json({ error: 'Investigation not found' }, { status: 404 })
  }

  const cursorOpt = cursor ? { id: cursor } : undefined
  const items = await prisma.investigationAudit.findMany({
    where: { investigationId: id },
    orderBy: { timestamp: 'desc' },
    take: limit + 1,
    cursor: cursorOpt,
  })

  const hasMore = items.length > limit
  const data = items.slice(0, limit)
  const nextCursor = hasMore ? items[items.length - 1].id : null

  return NextResponse.json({
    entries: data,
    pagination: { nextCursor, hasMore },
  })
}
