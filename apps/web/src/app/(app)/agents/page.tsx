import { prisma } from '@/lib/db'
import { AgentFeed } from '@/components/agents/AgentFeed'
import { TeamDetailPanel } from '@/components/tasks/TeamDetailPanel'

export const dynamic = 'force-dynamic'

export default async function AgentsPage() {
  const [messagesRaw, agentsRaw] = await Promise.all([
    prisma.agentMessage.findMany({ orderBy: { createdAt: 'desc' }, take: 50, include: { agent: true } }),
    prisma.agent.findMany({ orderBy: { name: 'asc' } }),
  ])

  const messages = messagesRaw.map(msg => ({
    ...msg,
    createdAt: msg.createdAt.toISOString(),
  }))

  const agents = agentsRaw.map(a => ({
    ...a,
    lastSeen: a.lastSeen?.toISOString() ?? null,
  }))

  return (
    <div className="absolute inset-0 flex flex-col md:flex-row overflow-hidden">
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <TeamDetailPanel initialAgents={agents as any} />
      <AgentFeed initialMessages={messages} />
    </div>
  )
}
