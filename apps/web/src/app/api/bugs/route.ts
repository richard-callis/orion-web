import { makeCrudRoutes } from '@/lib/crud-route-factory'
import { CreateBugSchema } from '@/lib/validate'

const BUG_INCLUDE = {
  assignedUser: { select: { id: true, name: true, username: true, email: true, role: true } },
}

export const { GET, POST } = makeCrudRoutes({
  model:        'bug',
  createSchema: CreateBugSchema,
  orderBy:      { updatedAt: 'desc' },
  include:      BUG_INCLUDE,
  transformData: (data) => ({
    title:          data.title,
    description:    data.description    ?? null,
    severity:       data.severity       ?? 'medium',
    status:         data.status         ?? 'open',
    area:           data.area           ?? null,
    reportedBy:     data.reportedBy     ?? 'admin',
    assignedUserId: data.assignedUserId ?? null,
  }),
})
