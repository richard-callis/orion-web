'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { RefreshCw, ServerCrash } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ApiError, apiFetch, errorMessage } from '@/lib/api'
import { NodeGrid } from '@/components/infrastructure/NodeGrid'
import { PodTable } from '@/components/infrastructure/PodTable'
import type { CachedNode, CachedPod, NodeMetric } from '@/lib/k8s'
import type { MetricsServerResult } from '@/lib/metrics-server'

interface InfraResponse { nodes: CachedNode[]; pods: CachedPod[]; metrics?: NodeMetric[]; metricsError?: string }

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
  const [installing, setInstalling] = useState(false)
  const [installMsg, setInstallMsg] = useState<string | null>(null)

  async function installMetricsServer() {
    setInstalling(true)
    setInstallMsg(null)
    try {
      const res = await apiFetch<MetricsServerResult>(`/api/environments/${envId}/metrics-server`, { method: 'POST' })
      setInstallMsg(res.status === 'existing'
        ? 'This cluster already runs a metrics-server ORION does not manage — check that it is healthy.'
        : res.status === 'skipped' ? `Skipped: ${res.reason}`
        : 'metrics-server installed — node usage appears within a minute.')
      setTimeout(() => void mutate(), 45_000)
    } catch (err) {
      setInstallMsg(describe(err))
    } finally {
      setInstalling(false)
    }
  }

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
          <ServerCrash size={14} className="mt-0.5 shrink-0" aria-hidden />
          <span className="whitespace-pre-wrap">{describe(error)}</span>
        </div>
      )}

      {nodes.length > 0 && (
        <>
          {data?.metricsError && (
            <div role="status" className="flex flex-wrap items-start gap-3 rounded-lg border border-status-warning/30 bg-status-warning/10 px-4 py-3 text-xs text-status-warning">
              <div className="min-w-0 flex-1">
                <span className="font-medium">Node CPU/memory unavailable:</span>{' '}
                <span className="whitespace-pre-wrap break-words font-mono">{data.metricsError}</span>
                {installMsg && <p className="mt-2 whitespace-pre-wrap break-words text-text-secondary">{installMsg}</p>}
              </div>
              <Button variant="secondary" onClick={() => void installMetricsServer()} disabled={installing}>
                {installing ? 'Installing…' : 'Install metrics-server'}
              </Button>
            </div>
          )}
          <NodeGrid
            nodes={nodes}
            metrics={data?.metrics ?? []}
            selectedNode={selectedNode}
            onNodeClick={name => setSelectedNode(prev => prev === name ? null : name)}
          />
          <PodTable pods={pods} nodeFilter={selectedNode} />
        </>
      )}
    </div>
  )
}
