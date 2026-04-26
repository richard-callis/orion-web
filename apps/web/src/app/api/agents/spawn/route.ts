import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { parseBodyOrError, AgentSpawnSchema, AGENT_TYPES } from '@/lib/validate'

const RESERVED_NAMES = ['human', 'user', 'system', 'admin']

// POST /api/agents/spawn — create a new agent and optionally start a planning conversation
// Body: { name, role?, type?, description?, metadata?, startConversation? }
export async function POST(req: NextRequest) {
  // SOC2 [INPUT-001]: Validate request body with Zod schema
  const result = await parseBodyOrError(req, AgentSpawnSchema)
  if ('error' in result) return result.error

  const { data } = result

  // Check reserved names
  if (RESERVED_NAMES.includes(data.name.toLowerCase())) {
    return NextResponse.json(
      { error: `"${data.name}" is a reserved name` },
      { status: 400 }
    )
  }

  const agent = await prisma.agent.create({
    data: {
      name: data.name,
      type: data.type ?? 'claude',
      role: data.role ?? null,
      description: data.description ?? null,
      metadata: (data.metadata ?? undefined) as any,
    },
  })

  let conversation = null
  if (data.startConversation) {
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
  })
}
