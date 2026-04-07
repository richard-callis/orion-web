import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

const RESERVED_NAMES = ['human', 'user', 'system', 'admin']
const VALID_TYPES = ['claude', 'ollama', 'human']

export async function GET() {
  const agents = await prisma.agent.findMany({ orderBy: { name: 'asc' } })
  return NextResponse.json(agents)
}

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
  if (type !== 'human' && !body.metadata?.systemPrompt?.trim()) {
    return NextResponse.json({ error: 'metadata.systemPrompt is required for claude/ollama agents' }, { status: 400 })
  }

  const agent = await prisma.agent.create({
    data: {
      name:        body.name.trim(),
      type,
      role:        body.role        ?? null,
      description: body.description ?? null,
      metadata:    body.metadata    ?? undefined,
    },
  })
  return NextResponse.json(agent, { status: 201 })
}
