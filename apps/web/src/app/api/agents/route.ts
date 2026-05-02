import { makeCrudRoutes } from '@/lib/crud-route-factory'
import { CreateAgentSchema } from '@/lib/validate'
import { RESERVED_AGENT_NAMES } from '@/lib/management-tools'

// SOC2 [INPUT-001]: Extended validation with reserved name check
const CreateAgentWithReservedCheck = CreateAgentSchema.refine(
  (data) => !RESERVED_AGENT_NAMES.includes(data.name.toLowerCase()),
  { message: 'Agent name is reserved', path: ['name'] }
)

export const { GET, POST } = makeCrudRoutes({
  model:        'agent',
  createSchema: CreateAgentWithReservedCheck,
  requireAuth:  false,
  orderBy:      { name: 'asc' },
  transformData: (data) => ({
    name:     data.name,
    type:     data.type ?? 'claude',
    role:     data.role ?? null,
    ...(data.metadata ? { metadata: data.metadata } : {}),
  }),
})
