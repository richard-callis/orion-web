import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

const RESERVED_NAMES = ['human', 'user', 'system', 'admin']
const VALID_TYPES = ['claude', 'ollama', 'human', 'custom']

// POST /api/agents/spawn — create a new agent and optionally start a planning conversation
// Body: { name, role?, type?, description?, metadata: { systemPrompt, contextConfig? }, startConversation? }
export async function POST(req: NextRequest) {
  const body = await req.json()

  if (!body.name?.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }
  if (RESERVED_NAMES.includes(body.name.trim().toLowerCase())) {
    return NextResponse.json({ error: `"${body.name}" is a reserved name` }, { status: 400 })
  }
  const type = body.type ?? 'claude'
  if (!VALID_TYPES.includes(type)) {
    return NextResponse.json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` }, { status: 400 })
  }

  const agent = await prisma.agent.create({
    data: {
      name:        body.name.trim(),
      type,
      role:        body.role        ?? null,
      description: body.description ?? null,
      metadata:    (body.metadata ?? undefined) as any,
    },
  })

  let conversation = null
  if (body.startConversation) {
    conversation = await prisma.conversation.create({
      data: {
        title: `Plan: ${agent.name}`,
        metadata: {
          agentTarget: { id: agent.id, name: agent.name },
        } as any,
      },
    })
  }

  return NextResponse.json({
    agent,
    conversation,
    ...(conversation && {
      streamUrl: `/api/chat/conversations/${conversation.id}/stream`,
      hint: `POST ${`/api/chat/conversations/${conversation.id}/stream`} with { "prompt": "..." } to plan the agent`,
    }),
  }, { status: 201 })
}
