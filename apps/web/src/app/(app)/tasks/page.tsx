import { Suspense } from 'react'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { TasksPage } from '@/components/tasks/TasksPage'
import type { Agent, Bug, Task } from '@/types/tasks'

export const dynamic = 'force-dynamic'

// Upper bounds for the initial render. The board is ordered by most recently
// updated, so anything beyond these limits is the long tail of old items.
const MAX_TASKS = 2000
const MAX_BUGS = 500
const MAX_PLANNING_CONVERSATIONS = 200

// Explicit field lists: this data is serialized into the page, so it must
// never include secrets (User.passwordHash / TOTP / tokens, Agent.mcpToken).
const USER_SELECT = { id: true, name: true, username: true, email: true, role: true } satisfies Prisma.UserSelect
const AGENT_SELECT = {
  id: true, name: true, type: true, role: true, description: true, status: true, metadata: true,
} satisfies Prisma.AgentSelect

type AgentRow = Prisma.AgentGetPayload<{ select: typeof AGENT_SELECT }>

function toAgent(a: AgentRow): Agent {
  return { ...a, metadata: (a.metadata ?? null) as Agent['metadata'] }
}

export default async function TasksPageRoute() {
  const [tasksRaw, epicsRaw, agentsRaw, usersRaw, convosRaw, bugsRaw] = await Promise.all([
    prisma.task.findMany({
      orderBy: { updatedAt: 'desc' },
      take: MAX_TASKS,
      include: { agent: { select: AGENT_SELECT }, assignedUser: { select: USER_SELECT } },
    }),
    prisma.epic.findMany({
      orderBy: { updatedAt: 'desc' },
      include: { features: { include: { _count: { select: { tasks: true } } }, orderBy: { createdAt: 'asc' } } },
    }),
    prisma.agent.findMany({ orderBy: { name: 'asc' }, select: AGENT_SELECT }),
    prisma.user.findMany({ where: { active: true }, orderBy: { name: 'asc' }, select: USER_SELECT }),
    // Planning conversations: only those with a planTarget in metadata
    prisma.conversation.findMany({
      where: { archivedAt: null, metadata: { path: ['planTarget'], not: Prisma.AnyNull } },
      select: { id: true, title: true, metadata: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: MAX_PLANNING_CONVERSATIONS,
    }),
    prisma.bug.findMany({
      orderBy: { updatedAt: 'desc' },
      take: MAX_BUGS,
      include: { assignedUser: { select: USER_SELECT } },
    }),
  ])

  const tasks: Task[] = tasksRaw.map(t => ({
    ...t,
    agent: t.agent ? toAgent(t.agent) : null,
    metadata: (t.metadata ?? null) as Task['metadata'],
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  }))

  const epics = epicsRaw.map(e => ({
    ...e,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    planApprovedAt: e.planApprovedAt?.toISOString() ?? null,
    features: e.features.map(f => ({
      ...f,
      createdAt: f.createdAt.toISOString(),
      updatedAt: f.updatedAt.toISOString(),
      planApprovedAt: f.planApprovedAt?.toISOString() ?? null,
    })),
  }))

  const planningConvos = convosRaw.map(c => ({
    id: c.id,
    title: c.title,
    metadata: c.metadata as { planTarget: { type: string; id: string } },
    updatedAt: c.updatedAt.toISOString(),
  }))

  const bugs: Bug[] = bugsRaw.map(b => ({
    ...b,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  }))

  return (
    <Suspense>
      <TasksPage
        initialTasks={tasks}
        initialEpics={epics}
        initialAgents={agentsRaw.map(toAgent)}
        initialUsers={usersRaw}
        initialPlanningConvos={planningConvos}
        initialBugs={bugs}
      />
    </Suspense>
  )
}
