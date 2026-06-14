/**
 * POST /api/monitoring/security/investigations/[id]/auto-extract-observables
 *
 * Scan linked incidents; returns extracted observables for analyst review before saving.
 */

import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { extractFromEvents } from '@/lib/security/extract-observables'

export const dynamic = 'force-dynamic'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const id = (await params).id

  const investigation = await prisma.investigation.findUnique({
    where: { id },
    include: {
      incidents: {
        include: {
          events: { select: { source: true, rawEvent: true, id: true } },
        },
      },
    },
  })

  if (!investigation) {
    return NextResponse.json({ error: 'Investigation not found' }, { status: 404 })
  }

  // Flatten all events from linked incidents
  const allEvents = investigation.incidents.flatMap(
    incident => incident.events.map(event => ({
      source: event.source,
      rawEvent: event.rawEvent as Record<string, unknown>,
    })),
  )

  const extracted = extractFromEvents(allEvents)

  // Save each observable (upsert by investigationId+value+category)
  const saved = []
  for (const obs of extracted) {
    const existing = await prisma.investigationObservable.findUnique({
      where: {
        investigationId_value_category: {
          investigationId: id,
          value: obs.value,
          category: obs.category,
        },
      },
    })
    if (!existing) {
      const created = await prisma.investigationObservable.create({
        data: {
          investigationId: id,
          value: obs.value,
          displayValue: obs.displayValue,
          category: obs.category,
          confidence: obs.confidence,
        },
      })
      saved.push(created)
    }
  }

  return NextResponse.json({
    extracted: extracted.length,
    saved,
    existing: extracted.length - saved.length,
  })
}
