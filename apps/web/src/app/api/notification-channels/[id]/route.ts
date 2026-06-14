import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const channel = await prisma.notificationChannel.findUnique({ where: { id: (await params).id } })
  if (!channel) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(channel)
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const body = await req.json() as Partial<{
    name: string
    type: string
    webhookUrl: string
    events: string
    agentFilter: string | null
    enabled: boolean
  }>

  const channel = await prisma.notificationChannel.update({
    where: { id: (await params).id },
    data: body,
  })
  return NextResponse.json(channel)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  await prisma.notificationChannel.delete({ where: { id: (await params).id } })
  return new NextResponse(null, { status: 204 })
}
