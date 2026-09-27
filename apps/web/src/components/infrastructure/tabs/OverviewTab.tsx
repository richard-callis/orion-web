'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { RefreshCw, ServerCrash } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ApiError, errorMessage } from '@/lib/api'
import { NodeGrid } from '@/components/infrastructure/NodeGrid'
import { PodTable } from '@/components/infrastructure/PodTable'
import type { CachedNode, CachedPod } from '@/lib/k8s'

interface InfraResponse { nodes: CachedNode[]; pods: CachedPod[] }

/** The infrastructure route returns { error, detail } — show both. */
function describe(err: unknown): string {
  if (err instanceof ApiError && err.body && typeof err.body === 'object') {
    const b = err.body as { error?: string; detail?: string }
    const msg = b.error ?? err.message
    return b.detail ? `${msg}\n\n${b.detail}` : msg
  }
  return errorMessage(err)
}

export function OverviewTab({ envId }: { envId: string }) {
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const { data, error, isValidating, mutate } = useSWR<InfraResponse>(
    `/api/environments/${envId}/infrastructure`,
    { revalidateOnFocus: false },
  )
  const nodes = data?.nodes ?? []
  const pods = (data?.pods ?? []).map(p => ({ ...p, age: new Date(p.age) }))

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Button variant="secondary" onClick={() => { setSelectedNode(null); void mutate() }} disabled={isValidating}>
          <RefreshCw size={11} className={isValidating ? 'animate-spin' : ''} aria-hidden />
          Refresh
        </Button>
        {isValidating && <span className="text-xs text-text-muted" role="status">Loading…</span>}
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-3 text-sm text-status-error">
          <ServerCrash size={14} className="mt-0.5 flex-shrink-0" aria-hidden />
          <span className="whitespace-pre-wrap">{describe(error)}</span>
        </div>
      )}

      {nodes.length > 0 && (
        <>
          <NodeGrid
            nodes={nodes}
            metrics={[]}
            selectedNode={selectedNode}
            onNodeClick={name => setSelectedNode(prev => prev === name ? null : name)}
          />
          <PodTable pods={pods} nodeFilter={selectedNode} />
        </>
      )}
    </div>
  )
}
