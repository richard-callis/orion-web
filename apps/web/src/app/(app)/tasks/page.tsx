import { Suspense } from 'react'
import { prisma } from '@/lib/db'
import { TasksPage } from '@/components/tasks/TasksPage'

export const dynamic = 'force-dynamic'

export default async function TasksPageRoute() {
  const [tasksRaw, epicsRaw, agentsRaw, usersRaw, convosRaw, bugsRaw] = await Promise.all([
    prisma.task.findMany({ orderBy: { updatedAt: 'desc' }, include: { agent: true, assignedUser: true } }),
    prisma.epic.findMany({
      orderBy: { updatedAt: 'desc' },
      include: { features: { include: { _count: { select: { tasks: true } } }, orderBy: { createdAt: 'asc' } } },
    }),
    prisma.agent.findMany({ orderBy: { name: 'asc' } }),
    prisma.user.findMany({ where: { active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true, username: true, email: true, role: true } }),
    // Load planning conversations (those with a planTarget in metadata)
    prisma.conversation.findMany({
      where: { archivedAt: null },
      select: { id: true, title: true, metadata: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.bug.findMany({
      orderBy: { updatedAt: 'desc' },
      include: { assignedUser: { select: { id: true, name: true, username: true, email: true, role: true } } },
    }),
  ])

  const tasks = tasksRaw.map(t => ({
    ...t,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  }))

  const epics = epicsRaw.map(e => ({
    ...e,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    features: e.features.map(f => ({
      ...f,
      createdAt: f.createdAt.toISOString(),
      updatedAt: f.updatedAt.toISOString(),
    })),
  }))

  // Filter to only planning conversations (those with planTarget in metadata)
  const planningConvos = convosRaw
    .filter(c => c.metadata && typeof c.metadata === 'object' && 'planTarget' in (c.metadata as object))
    .map(c => ({
      id: c.id,
      title: c.title,
      metadata: c.metadata as { planTarget: { type: string; id: string } },
      updatedAt: c.updatedAt.toISOString(),
    }))

  const bugs = bugsRaw.map(b => ({
    ...b,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  }))

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return <Suspense><TasksPage initialTasks={tasks as any} initialEpics={epics} initialAgents={agentsRaw as any} initialUsers={usersRaw} initialPlanningConvos={planningConvos} initialBugs={bugs as any} /></Suspense>
}
