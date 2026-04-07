'use client'
import { useState } from 'react'
import type { CachedPod, CachedNode, NodeMetric } from '@/lib/k8s'
import { NodeGrid } from './NodeGrid'
import { PodTable } from './PodTable'

interface Props {
  nodes: CachedNode[]
  pods: CachedPod[]
  metrics: NodeMetric[]
}

export function InfrastructureClient({ nodes, pods, metrics }: Props) {
  const [selectedNode, setSelectedNode] = useState<string | null>(null)

  const handleNodeClick = (name: string) => {
    setSelectedNode(prev => prev === name ? null : name)
  }

  return (
    <div className="space-y-6 p-4 lg:p-6">
      <NodeGrid nodes={nodes} metrics={metrics} selectedNode={selectedNode} onNodeClick={handleNodeClick} />
      <PodTable pods={pods} nodeFilter={selectedNode} />
    </div>
  )
}
