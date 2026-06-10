import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const trigger = await prisma.webhookTrigger.findUnique({
    where: { id },
    include: { agent: { select: { id: true, name: true } } },
  })
  if (!trigger) return new NextResponse(null, { status: 404 })

  // Derive the webhook URL from the trigger id — client passes the base URL if needed
  return NextResponse.json({
    ...trigger,
    // Mask secret — only show prefix
    secret: '••••••••',
    webhookUrl: `/api/webhooks/${id}`,
  })
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  let body: {
    name?: string
    taskTitle?: string
    taskDesc?: string
    enabled?: boolean
    source?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const existing = await prisma.webhookTrigger.findUnique({ where: { id } })
  if (!existing) return new NextResponse(null, { status: 404 })

  const data: Record<string, unknown> = {}
  if (body.name      !== undefined) data.name      = body.name
  if (body.taskTitle !== undefined) data.taskTitle = body.taskTitle
  if (body.taskDesc  !== undefined) data.taskDesc  = body.taskDesc
  if (body.enabled   !== undefined) data.enabled   = body.enabled
  if (body.source    !== undefined) data.source    = body.source

  const trigger = await prisma.webhookTrigger.update({
    where: { id },
    data,
    include: { agent: { select: { id: true, name: true } } },
  })
  return NextResponse.json({ ...trigger, secret: '••••••••', webhookUrl: `/api/webhooks/${id}` })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const existing = await prisma.webhookTrigger.findUnique({ where: { id } })
  if (!existing) return new NextResponse(null, { status: 404 })
  await prisma.webhookTrigger.delete({ where: { id } })
  return new NextResponse(null, { status: 204 })
}
