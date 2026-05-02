import { prisma } from '@/lib/db'
import { makeCrudRoutes } from '@/lib/crud-route-factory'
import { CreateEpicSchema } from '@/lib/validate'

const EPIC_INCLUDE = {
  features: {
    include: { _count: { select: { tasks: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
}

export const { GET, POST } = makeCrudRoutes({
  model:        'epic',
  createSchema: CreateEpicSchema,
  orderBy:      { updatedAt: 'desc' },
  include:      EPIC_INCLUDE,
  transformData: (data, caller) => ({
    title:       data.title,
    description: data.description ?? null,
    plan:        data.plan,
    status:      data.status,
    createdBy:   caller?.id ?? 'gateway',
  }),
  afterCreate: async (record, caller) => {
    const epic = record as { id: string; title: string }
    await prisma.chatRoom.create({
      data: {
        name:      `${epic.title} — Planning`,
        type:      'planning',
        epicId:    epic.id,
        createdBy: caller?.id ?? 'system',
        ...(caller?.id ? { members: { create: [{ userId: caller.id, role: 'lead' }] } } : {}),
      },
    })
  },
})
