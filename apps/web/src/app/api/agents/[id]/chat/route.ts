import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

// POST /api/agents/:id/chat — start a chat conversation with an agent
// Returns the conversation object so the caller can use the chat stream endpoint
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const agent = await prisma.agent.findUnique({ where: { id: params.id } })
  if (!agent) return new NextResponse(null, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const title = body.title ?? `Chat: ${agent.name}`

  const conversation = await prisma.conversation.create({
    data: {
      title,
      metadata: { agentChat: { id: agent.id, name: agent.name } } as any,
    },
  })

  return NextResponse.json({
    conversation,
    streamUrl: `/api/chat/conversations/${conversation.id}/stream`,
    hint: `POST ${`/api/chat/conversations/${conversation.id}/stream`} with { "prompt": "..." } to send messages`,
  }, { status: 201 })
}
