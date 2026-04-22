import type { ComponentType } from 'react'
import nextDynamic from 'next/dynamic'

// Force-graph-2d (Three.js) is browser-only — disable SSR
const GraphViewClient = nextDynamic<{ }>(
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

// Force dynamic rendering — prevents Next.js from prerendering
// which crashes on react-force-graph-2d's window access
export const dynamic = 'force-dynamic'

export default function GraphPage() {
  return <GraphViewClient />
}
