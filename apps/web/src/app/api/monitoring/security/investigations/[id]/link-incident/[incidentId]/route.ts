/**
 * DELETE /api/monitoring/security/investigations/[id]/link-incident/[incidentId]
 *
 * Unlink (split) an incident from an investigation.
 */

import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { recordAudit } from '../../../_utils'

export const dynamic = 'force-dynamic'

export async function DELETE(_req: Request, { params }: { params: { id: string; incidentId: string } }) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const { id, incidentId } = await params

  const incident = await prisma.incident.findUnique({ where: { id: incidentId } })
  if (!incident || incident.investigationId !== id) {
    return NextResponse.json({ error: 'Incident not linked to this investigation' }, { status: 404 })
  }

  await prisma.incident.update({
    where: { id: incidentId },
    data: { investigationId: null },
  })

  await recordAudit(id, 'admin', 'human', 'link_added',
    { incidentId, action: 'linked' }, { incidentId, action: 'unlinked' })

  await prisma.investigationTimeline.create({
    data: {
      investigationId: id, eventTime: new Date(),
      eventType: 'link_removed',
      title: `Incident unlinked: ${incident.attackerKey ?? incidentId}`,
      source: 'manual',
    },
  })

  return NextResponse.json({ ok: true })
}
