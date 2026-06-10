import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const channel = await prisma.notificationChannel.findUnique({ where: { id: params.id } })
  if (!channel) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(channel)
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const body = await req.json() as Partial<{
    name: string
    type: string
    webhookUrl: string
    events: string
    agentFilter: string | null
    enabled: boolean
  }>

  const channel = await prisma.notificationChannel.update({
    where: { id: params.id },
    data: body,
  })
  return NextResponse.json(channel)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  await prisma.notificationChannel.delete({ where: { id: params.id } })
  return new NextResponse(null, { status: 204 })
}
