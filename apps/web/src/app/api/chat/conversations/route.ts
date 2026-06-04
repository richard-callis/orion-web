import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCallerId } from '@/lib/conversation-owner'
import { CreateConversationSchema } from '@/lib/validate'

export async function GET(req: NextRequest) {
  // B1 fix: scope list to conversations owned by the caller
  const callerId = await getCallerId(req)
  if (!callerId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const convos = await prisma.conversation.findMany({
    where: {
      archivedAt: null,
      // Filter by ownerId stored in metadata (added at creation time).
      // Legacy rows without ownerId won't appear — acceptable; admins can
      // access those via direct id lookup.
      metadata: { path: ['ownerId'], equals: callerId },
    },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    include: { _count: { select: { messages: true } } },
  })
  return NextResponse.json(convos)
}

export async function POST(req: NextRequest) {
  // Stamp ownerId at creation so all subsequent reads can be scoped
  const callerId = await getCallerId(req)
  if (!callerId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const rawBody = await req.json().catch(() => ({}))
  const body = typeof rawBody === 'object' && rawBody !== null ? rawBody : {}

  const parsed = CreateConversationSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.errors.map(e => ({ field: e.path.join('.'), message: e.message })) },
      { status: 400 },
    )
  }

  const meta: Record<string, unknown> = {
    ownerId: callerId,  // B1 fix: stamp owner for future scoping
  }
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
      metadata: meta as any,
    },
    include: { _count: { select: { messages: true } } },
  })
  return NextResponse.json(convo, { status: 201 })
}
