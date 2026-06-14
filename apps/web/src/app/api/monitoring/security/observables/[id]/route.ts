/**
 * GET /api/monitoring/security/observables/[id]
 *
 * Observable detail with cross-investigation aggregation.
 */

import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const id = (await params).id

  const observable = await prisma.investigationObservable.findUnique({
    where: { id },
    include: {
      investigation: { select: { id: true, name: true, status: true } },
    },
  })

  if (!observable) {
    return NextResponse.json({ error: 'Observable not found' }, { status: 404 })
  }

  // Cross-investigation aggregation: find same value+category in other investigations
  const crossRefs = await prisma.investigationObservable.findMany({
    where: {
      value: observable.value,
      category: observable.category,
      investigationId: { not: observable.investigationId },
    },
    include: {
      investigation: { select: { id: true, name: true, status: true } },
    },
    take: 20,
  })

  return NextResponse.json({
    observable: { ...observable },
    crossReferences: crossRefs,
  })
}
