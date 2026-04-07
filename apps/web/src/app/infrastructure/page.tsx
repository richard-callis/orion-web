import { getCache, startWatchers, refreshCache, fetchNodeMetrics } from '@/lib/k8s'
import { InfrastructureClient } from '@/components/infrastructure/InfrastructureClient'

if (process.env.NODE_ENV !== 'test') {
  startWatchers().catch(console.error)
}

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function InfrastructurePage() {
  // If cache is cold (first request after pod start), populate it before rendering
  let { pods, nodes } = getCache()
  const [metrics] = await Promise.all([
    fetchNodeMetrics(),
    nodes.length === 0 ? refreshCache() : Promise.resolve(),
  ])
  if (nodes.length === 0) ({ pods, nodes } = getCache())

  return <InfrastructureClient nodes={nodes} pods={pods} metrics={metrics} />
}
