import type { ComponentType } from 'react'
import dynamic from 'next/dynamic'

// Force-graph-2d (Three.js) is browser-only — disable SSR
const GraphViewClient = dynamic<{ }>(
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

export default function GraphPage() {
  return <GraphViewClient />
}
