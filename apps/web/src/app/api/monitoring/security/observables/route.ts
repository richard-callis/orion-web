/**
 * GET /api/monitoring/security/observables
 *
 * Global observable search (paginated, rate-limited to 10 req/min).
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

/** Simple in-memory rate limiter (per-IP). In production, use Redis. */
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>()

function checkRateLimit(ip: string, max: number = 10, windowMs: number = 60000): boolean {
  const now = Date.now()
  // Evict expired buckets to prevent unbounded growth
  for (const [key, b] of rateLimitBuckets.entries()) {
    if (now > b.resetAt) rateLimitBuckets.delete(key)
  }
  const bucket = rateLimitBuckets.get(ip)
  if (!bucket || now > bucket.resetAt) {
    rateLimitBuckets.set(ip, { count: 1, resetAt: now + windowMs })
    return true
  }
  if (bucket.count >= max) return false
  bucket.count++
  return true
}

export async function GET(req: NextRequest) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const ip = req.headers.get('x-forwarded-for') ?? 'unknown'
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ error: 'Rate limit exceeded (10 req/min)' }, { status: 429 })
  }

  const q = req.nextUrl.searchParams.get('q')
  const category = req.nextUrl.searchParams.get('category')
  const verdict = req.nextUrl.searchParams.get('verdict')
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') ?? '25', 10), 100)
  const cursor = req.nextUrl.searchParams.get('cursor')

  const where: Record<string, unknown> = {}
  if (q) where.value = { contains: q, mode: 'insensitive' }
  if (category) where.category = category
  if (verdict) where.verdict = verdict

  const cursorOpt = cursor ? { id: cursor } : undefined
  const items = await prisma.investigationObservable.findMany({
    where,
    orderBy: { lastSeen: 'desc' },
    take: limit + 1,
    cursor: cursorOpt,
    include: {
      investigation: { select: { id: true, name: true, status: true } },
    },
  })

  const hasMore = items.length > limit
  const data = items.slice(0, limit)
  const nextCursor = hasMore ? items[items.length - 1].id : null

  return NextResponse.json({
    observables: data,
    pagination: { nextCursor, hasMore },
  })
}
