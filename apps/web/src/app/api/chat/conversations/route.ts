import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import type { Prisma } from '@prisma/client'
import { CreateConversationSchema } from '@/lib/validate'

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
  // SOC2: Input validation — validate and sanitize all request body fields
  const rawBody = await req.json().catch(() => ({}))
  const body = typeof rawBody === 'object' && rawBody !== null ? rawBody : {}

  const parsed = CreateConversationSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.errors.map(e => ({ field: e.path.join('.'), message: e.message })) },
      { status: 400 },
    )
  }

  const meta: Record<string, unknown> = {}
  if (parsed.data.initialContext) meta.initialContext = parsed.data.initialContext
  if (parsed.data.planTarget)     meta.planTarget     = parsed.data.planTarget
  if (parsed.data.planModel)      meta.planModel      = parsed.data.planModel
  if (parsed.data.agentTarget)    meta.agentTarget    = parsed.data.agentTarget
  if (parsed.data.agentDraft)     meta.agentDraft     = parsed.data.agentDraft
  if (parsed.data.agentChat)      meta.agentChat      = parsed.data.agentChat
  if (parsed.data.metadata?.debugChat) meta.debugChat = true

  const convo = await prisma.conversation.create({
    data: {
      title: parsed.data.title ? parsed.data.title.slice(0, 200) : null,
      metadata: Object.keys(meta).length ? meta as Prisma.InputJsonObject : undefined,
    },
    include: { _count: { select: { messages: true } } },
  })
  return NextResponse.json(convo, { status: 201 })
}
