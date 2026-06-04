/**
 * POST /api/security/incidents/[id]/create-investigation
 *
 * One-click create investigation from incident detail.
 * Pre-populates name, severity, links the incident, auto-extracts observables.
 */

import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { extractFromEvents } from '@/lib/security/extract-observables'

export const dynamic = 'force-dynamic'

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const incidentId = (await params).id

  const incident = await prisma.incident.findUnique({
    where: { id: incidentId },
    include: {
      events: { select: { source: true, rawEvent: true, id: true, createdAt: true } },
    },
  })

  if (!incident) {
    return NextResponse.json({ error: 'Incident not found' }, { status: 404 })
  }

  // Check if already linked to an investigation
  if (incident.investigationId) {
    return NextResponse.json({ error: 'Incident already linked to investigation' }, { status: 409 })
  }

  const investigation = await prisma.investigation.create({
    data: {
      name: `[${incident.attackerKey ?? incident.id.slice(0, 8)}] ${incident.rootCauseSummary ?? 'Investigation'}`,
      severity: incident.severity,
      createdBy: 'admin',
    },
  })

  // Link the incident
  await prisma.incident.update({
    where: { id: incidentId },
    data: { investigationId: investigation.id },
  })

  // Auto-extract observables from incident events
  const extracted = extractFromEvents(
    incident.events.map(e => ({ source: e.source, rawEvent: e.rawEvent as Record<string, unknown> })),
  )

  const saved = []
  for (const obs of extracted) {
    const created = await prisma.investigationObservable.create({
      data: {
        investigationId: investigation.id,
        value: obs.value,
        displayValue: obs.displayValue,
        category: obs.category,
        confidence: obs.confidence,
      },
    })
    saved.push(created)
  }

  // Timeline entry
  await prisma.investigationTimeline.create({
    data: {
      investigationId: investigation.id,
      eventTime: new Date(),
      eventType: 'incident_created',
      title: `Investigation created from incident ${incidentId}`,
      description: `Severity: ${incident.severity}, Attacker: ${incident.attackerKey ?? 'Unknown'}`,
      source: 'manual',
    },
  })

  return NextResponse.json({
    investigation,
    observablesExtracted: saved.length,
  }, { status: 201 })
}
