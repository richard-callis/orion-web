import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

function maskUrl(url: string): string {
  if (url.length <= 4) return '****'
  return '****' + url.slice(-4)
}

export async function GET() {
  await requireAdmin()
  const channels = await prisma.notificationChannel.findMany({
    orderBy: { createdAt: 'desc' },
    take: 200,
  })
  return NextResponse.json(
    channels.map(c => ({ ...c, webhookUrl: maskUrl(c.webhookUrl) }))
  )
}

export async function POST(req: NextRequest) {
  await requireAdmin()
  const body = await req.json() as {
    name: string
    type: string
    webhookUrl: string
    events?: string
    agentFilter?: string
    enabled?: boolean
  }

  if (!body.name || !body.type || !body.webhookUrl) {
    return NextResponse.json({ error: 'name, type, and webhookUrl are required' }, { status: 400 })
  }

  const channel = await prisma.notificationChannel.create({
    data: {
      name: body.name,
      type: body.type,
      webhookUrl: body.webhookUrl,
      events: body.events ?? '["task_completed","task_failed"]',
      agentFilter: body.agentFilter ?? null,
      enabled: body.enabled ?? true,
    },
  })

  return NextResponse.json({ ...channel, webhookUrl: maskUrl(channel.webhookUrl) }, { status: 201 })
}
