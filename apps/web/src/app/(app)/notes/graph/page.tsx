import type { ComponentType } from 'react'
import dynamicLoader from 'next/dynamic'

// Force-graph-2d (Three.js) is browser-only — disable SSR
const GraphViewClient = dynamicLoader<{ }>(
  async () => {
    const mod = await import('@/components/notes/GraphView')
    return mod.GraphView as ComponentType
  },
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-full text-text-muted text-sm">
        Loading knowledge graph...
      </div>
    ),
  },
)

// Force dynamic rendering — react-force-graph-2d accesses window at load time
export const dynamic = 'force-dynamic'

export default function GraphPage() {
  return <GraphViewClient />
}
