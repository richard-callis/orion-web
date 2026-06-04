/**
 * GET /api/monitoring/security/incidents/[id]
 *
 * Get full incident details with events, action audit trail, and Warden chat messages.
 */

import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const incidentId = params.id

  const incident = await prisma.incident.findUnique({
    where: { id: incidentId },
    select: {
      id: true,
      status: true,
      severity: true,
      rootCauseSummary: true,
      attackerKey: true,
      hostKey: true,
      openedAt: true,
      closedAt: true,
      environmentId: true,
      investigationId: true,
    },
  })

  if (!incident) {
    return NextResponse.json({ error: 'Incident not found' }, { status: 404 })
  }

  // Fetch linked events
  const events = await prisma.securityEvent.findMany({
    where: { incidentId },
    orderBy: { createdAt: 'asc' },
    take: 100,
    select: {
      id: true,
      type: true,
      source: true,
      severity: true,
      title: true,
      createdAt: true,
      acknowledged: true,
    },
  })

  // Fetch action audit trail
  const actions = await prisma.actionAudit.findMany({
    where: { incidentId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      actionType: true,
      target: true,
      tier: true,
      status: true,
      proposedBy: true,
      approvedBy: true,
      result: true,
      payload: true,
      createdAt: true,
    },
  })

  // Fetch Warden chat messages for this incident (from security room).
  // Default to [] (not undefined) so the UI never crashes when the security
  // room isn't seeded yet — addresses the B4 chat-tab crash on a fresh DB.
  const securityRoomId = await import('@/lib/seed-system-epic').then(
    m => m.getSystemRoomId('system.room.security')
  )

  let chatMessages: Array<{ id: string; content: string; createdAt: string; senderType: string }> = []
  if (securityRoomId) {
    const raw = await prisma.chatMessage.findMany({
      where: {
        roomId: securityRoomId,
        content: { contains: incidentId, mode: 'insensitive' },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, content: true, createdAt: true, senderType: true },
      take: 50,
    })
    chatMessages = raw.map((m: any) => ({
      ...m,
      createdAt: m.createdAt.toISOString(),
    }))
  }

  return NextResponse.json({
    incident,
    events,
    actions,
    chatMessages,
  })
}
