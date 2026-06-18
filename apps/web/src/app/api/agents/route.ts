import { NextRequest, NextResponse } from 'next/server'
import { makeCrudRoutes } from '@/lib/crud-route-factory'
import { CreateAgentSchema } from '@/lib/validate'
import { RESERVED_AGENT_NAMES } from '@/lib/management-tools'
import { logAudit } from '@/lib/audit'
import { requireAdmin, requireAuth } from '@/lib/auth'
import { prisma } from '@/lib/db'

// SOC2 [INPUT-001]: Extended validation with reserved name check
const CreateAgentWithReservedCheck = CreateAgentSchema.refine(
  (data) => !RESERVED_AGENT_NAMES.includes(data.name.toLowerCase()),
  { message: 'Agent name is reserved', path: ['name'] }
)

export async function GET(_req: NextRequest): Promise<NextResponse> {
  let caller
  try {
    caller = await requireAuth()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Admins see all agents; non-admins see only their own or shared (createdBy null) agents
  const where =
    caller.role === 'admin'
      ? {}
      : { OR: [{ createdBy: caller.id }, { createdBy: null }] }

  const agents = await prisma.agent.findMany({ where, orderBy: { name: 'asc' } })
  return NextResponse.json(agents)
}

// SOC2 [PRIV-001]: Agent creation is admin-only — readonly/user roles must not be able
// to create agents with arbitrary systemPrompt that the worker executes with full cluster access.
export async function POST(req: NextRequest): Promise<NextResponse> {
  let caller
  try {
    caller = await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const crudRoutes = makeCrudRoutes({
    model:        'agent',
    createSchema: CreateAgentWithReservedCheck,
    requireAuth:  true,
    orderBy:      { name: 'asc' },
    transformData: (data) => ({
      name:      data.name,
      type:      data.type ?? 'claude',
      role:      data.role ?? null,
      createdBy: caller?.id ?? null,
      ...(data.metadata ? { metadata: data.metadata } : {}),
    }),
    afterCreate: async (record: any) => {
      // SOC2: audit agent creation
      logAudit({
        userId: caller?.id ?? 'unknown',
        action: 'agent_create',
        target: `agent:${record.id}`,
        detail: { name: record.name },
      }).catch(() => {})
    },
  })

  return crudRoutes.POST(req)
}
