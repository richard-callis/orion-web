import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const event = await prisma.securityEvent.findUnique({
    where: { id: params.id },
    select: {
      id: true,
      type: true,
      source: true,
      severity: true,
      title: true,
      description: true,
      rawEvent: true,
      acknowledged: true,
      acknowledgedAt: true,
      dedupKey: true,
      firstSeen: true,
      lastSeen: true,
      createdAt: true,
      incidentId: true,
      environmentId: true,
    },
  })

  if (!event) {
    return NextResponse.json({ error: 'Alert not found' }, { status: 404 })
  }

  return NextResponse.json({ event })
}
