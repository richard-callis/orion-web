export const dynamic = 'force-dynamic'

import { prisma } from '@/lib/db'
import { EnvironmentsPage } from '@/components/environments/EnvironmentsPage'
import { toEnvironmentDTO } from '@/lib/environment-dto'

export default async function Page() {
  const environments = await prisma.environment.findMany({
    orderBy: { name: 'asc' },
    include: {
      tools:  { orderBy: [{ builtIn: 'desc' }, { name: 'asc' }] },
      agents: { include: { agent: true } },
    },
  })

  // Strip every credential server-side before passing to the client (gateway
  // token, kubeconfig, federation token, metadata.talosConfig, agent MCP
  // tokens). The UI only gets hasX flags.
  const safe = environments.map(toEnvironmentDTO)

  return <EnvironmentsPage initialEnvironments={safe as Parameters<typeof EnvironmentsPage>[0]['initialEnvironments']} />
}
