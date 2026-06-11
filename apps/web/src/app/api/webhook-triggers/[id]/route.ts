import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { parseBodyOrError, UpdateWebhookTriggerSchema } from '@/lib/validate'

async function guard() {
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const deny = await guard(); if (deny) return deny
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
  const deny = await guard(); if (deny) return deny
  const { id } = await params
  const parsed = await parseBodyOrError(req, UpdateWebhookTriggerSchema)
  if ('error' in parsed) return parsed.error
  const { data } = parsed

  const existing = await prisma.webhookTrigger.findUnique({ where: { id } })
  if (!existing) return new NextResponse(null, { status: 404 })

  const updateData: Record<string, unknown> = {}
  if (data.name      !== undefined) updateData.name      = data.name
  if (data.taskTitle !== undefined) updateData.taskTitle = data.taskTitle
  if ('taskDesc'     in data)       updateData.taskDesc  = data.taskDesc ?? null
  if (data.enabled   !== undefined) updateData.enabled   = data.enabled
  if (data.source    !== undefined) updateData.source    = data.source

  const trigger = await prisma.webhookTrigger.update({
    where: { id },
    data: updateData,
    include: { agent: { select: { id: true, name: true } } },
  })
  return NextResponse.json({ ...trigger, secret: '••••••••', webhookUrl: `/api/webhooks/${id}` })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const deny = await guard(); if (deny) return deny
  const { id } = await params
  const existing = await prisma.webhookTrigger.findUnique({ where: { id } })
  if (!existing) return new NextResponse(null, { status: 404 })
  await prisma.webhookTrigger.delete({ where: { id } })
  return new NextResponse(null, { status: 204 })
}
