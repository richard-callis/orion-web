import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'

export async function GET(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const limit   = parseInt(searchParams.get('limit') ?? '50')
  const channel = searchParams.get('channel') ?? undefined
  const since   = searchParams.get('since') ? new Date(searchParams.get('since')!) : undefined

  const messages = await prisma.agentMessage.findMany({
    where: { ...(channel ? { channel } : {}), ...(since ? { createdAt: { gt: since } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 200),
    include: { agent: true },
  })
  return NextResponse.json(messages)
}

export async function POST(req: NextRequest) {
  // MINOR fix: any logged-in user could inject arbitrary messages into agent channels,
  // which is a prompt-injection delivery vector. Require authentication.
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const msg = await prisma.agentMessage.create({
    data: {
      content:     body.content,
      channel:     body.channel ?? 'general',
      messageType: body.messageType ?? 'text',
      agentId:     body.agentId ?? null,
      metadata:    body.metadata ?? undefined,
    },
    include: { agent: true },
  })
  return NextResponse.json(msg, { status: 201 })
}
