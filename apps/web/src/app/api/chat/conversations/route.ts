import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import type { Prisma } from '@prisma/client'

export async function GET() {
  const convos = await prisma.conversation.findMany({
    where: { archivedAt: null },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    include: { _count: { select: { messages: true } } },
  })
  return NextResponse.json(convos)
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const meta: Record<string, unknown> = {}
  if (body.initialContext) meta.initialContext = body.initialContext
  if (body.planTarget)     meta.planTarget     = body.planTarget
  if (body.planModel)      meta.planModel      = body.planModel
  if (body.agentTarget)    meta.agentTarget    = body.agentTarget
  if (body.agentDraft)     meta.agentDraft     = true
  if (body.agentChat)      meta.agentChat      = body.agentChat
  if (body.metadata?.debugChat) meta.debugChat = true
  const convo = await prisma.conversation.create({
    data: { title: body.title ?? null, metadata: Object.keys(meta).length ? meta as Prisma.InputJsonObject : undefined },
    include: { _count: { select: { messages: true } } },
  })
  return NextResponse.json(convo, { status: 201 })
}
