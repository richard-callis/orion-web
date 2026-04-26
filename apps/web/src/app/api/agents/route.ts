import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { parseBodyOrError, CreateAgentSchema } from '@/lib/validate'
import { z } from 'zod'

const RESERVED_NAMES = ['human', 'user', 'system', 'admin']

// SOC2 [INPUT-001]: Extended validation with reserved name check
const CreateAgentWithReservedCheck = CreateAgentSchema.refine(
  (data) => !RESERVED_NAMES.includes(data.name.toLowerCase()),
  { message: 'Agent name is reserved', path: ['name'] }
)

export async function GET() {
  const agents = await prisma.agent.findMany({ orderBy: { name: 'asc' } })
  return NextResponse.json(agents)
}

export async function POST(req: NextRequest) {
  // SOC2 [INPUT-001]: Validate request body with Zod schema
  const result = await parseBodyOrError(req, CreateAgentWithReservedCheck)
  if ('error' in result) return result.error

  const { data } = result  // { name, type, role?, metadata? }

  const agent = await prisma.agent.create({
    data: {
      name:     data.name,
      type:     data.type ?? 'claude',
      role:     data.role ?? null,
      ...(data.metadata && { metadata: data.metadata as any }),
    },
  })
  return NextResponse.json(agent, { status: 201 })
}
