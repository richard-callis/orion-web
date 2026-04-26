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

  // Mask tokens server-side before passing to client
  const safe = environments.map((e: any) => ({ ...e, gatewayToken: e.gatewayToken ? '••••' : null }))

  return <EnvironmentsPage initialEnvironments={safe as Parameters<typeof EnvironmentsPage>[0]['initialEnvironments']} />
}
