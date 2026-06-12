import { makeCrudRoutes } from '@/lib/crud-route-factory'
import { CreateAgentSchema } from '@/lib/validate'
import { RESERVED_AGENT_NAMES } from '@/lib/management-tools'
import { logAudit } from '@/lib/audit'

// SOC2 [INPUT-001]: Extended validation with reserved name check
const CreateAgentWithReservedCheck = CreateAgentSchema.refine(
  (data) => !RESERVED_AGENT_NAMES.includes(data.name.toLowerCase()),
  { message: 'Agent name is reserved', path: ['name'] }
)

export const { GET, POST } = makeCrudRoutes({
  model:        'agent',
  createSchema: CreateAgentWithReservedCheck,
  requireAuth:  true,
  orderBy:      { name: 'asc' },
  transformData: (data) => ({
    name:     data.name,
    type:     data.type ?? 'claude',
    role:     data.role ?? null,
    ...(data.metadata ? { metadata: data.metadata } : {}),
  }),
  afterCreate: async (record: any, caller: any) => {
    // SOC2: audit agent creation
    logAudit({
      userId: caller?.id ?? 'unknown',
      action: 'agent_create',
      target: `agent:${record.id}`,
      detail: { name: record.name },
    }).catch(() => {})
  },
})
