export const dynamic = 'force-dynamic'

import { prisma } from '@/lib/db'
import { EnvironmentsPage } from '@/components/environments/EnvironmentsPage'

export default async function Page() {
  const environments = await prisma.environment.findMany({
    orderBy: { name: 'asc' },
    include: {
      tools:  { orderBy: [{ builtIn: 'desc' }, { name: 'asc' }] },
      agents: { include: { agent: true } },
    },
  })

  // Mask secrets server-side before passing to client. kubeconfig is only
  // ever written (never read back) by the UI, and agent MCP tokens are unused.
  const safe = environments.map(e => ({
    ...e,
    gatewayToken: e.gatewayToken ? '••••' : null,
    kubeconfig: null,
    agents: e.agents.map(link => ({ ...link, agent: { ...link.agent, mcpToken: null } })),
  }))

  return <EnvironmentsPage initialEnvironments={safe as Parameters<typeof EnvironmentsPage>[0]['initialEnvironments']} />
}
