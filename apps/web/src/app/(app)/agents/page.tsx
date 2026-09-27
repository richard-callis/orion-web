import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { AgentFeed } from '@/components/agents/AgentFeed'
import { TeamDetailPanel } from '@/components/tasks/TeamDetailPanel'
import type { Agent } from '@/types/tasks'

export const dynamic = 'force-dynamic'

// Explicit field list: serialized into the page, so never the (encrypted) mcpToken.
const AGENT_SELECT = {
  id: true, name: true, type: true, role: true, description: true, status: true, metadata: true,
} satisfies Prisma.AgentSelect

export default async function AgentsPage() {
  const user = await getCurrentUser()
  // Same visibility as GET /api/agents (which the panel revalidates against):
  // admins see all agents, everyone else their own plus shared ones.
  const agentWhere: Prisma.AgentWhereInput =
    user?.role === 'admin' ? {} : { OR: [{ createdBy: user?.id ?? '__none__' }, { createdBy: null }] }

  const [messagesRaw, agentsRaw, pausedSetting] = await Promise.all([
    prisma.agentMessage.findMany({ orderBy: { createdAt: 'desc' }, take: 50, include: { agent: true } }),
    prisma.agent.findMany({ where: agentWhere, orderBy: { name: 'asc' }, select: AGENT_SELECT }),
    prisma.systemSetting.findUnique({ where: { key: 'system.watchers.paused' } }),
  ])

  // Never serialize the (encrypted) per-agent MCP token to the browser.
  const messages = messagesRaw.map(({ agent, ...msg }) => ({
    ...msg,
    agent: agent ? { ...agent, mcpToken: undefined } : agent,
    createdAt: msg.createdAt.toISOString(),
  }))

  const agents: Agent[] = agentsRaw.map(a => ({ ...a, metadata: (a.metadata ?? null) as Agent['metadata'] }))
  const initialPaused = pausedSetting?.value === true

  return (
    <div className="absolute inset-0 flex flex-col md:flex-row overflow-hidden">
      <TeamDetailPanel initialAgents={agents} />
      <AgentFeed initialMessages={messages} initialPaused={initialPaused} />
    </div>
  )
}
