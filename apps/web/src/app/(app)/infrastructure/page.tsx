'use client'

import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, ServerCrash } from 'lucide-react'
import type { CachedNode, CachedPod } from '@/lib/k8s'
import { NodeGrid } from '@/components/infrastructure/NodeGrid'
import { PodTable } from '@/components/infrastructure/PodTable'

interface Environment {
  id: string
  name: string
  type: string
  status: string
  gatewayUrl: string | null
}

const selectCls = 'text-xs bg-bg-raised border border-border-subtle rounded-lg px-2 py-1.5 text-text-primary focus:outline-none focus:ring-1 focus:ring-accent'

export default function InfrastructurePage() {
  const [environments, setEnvironments] = useState<Environment[]>([])
  const [envId, setEnvId]               = useState('')
  const [nodes, setNodes]               = useState<CachedNode[]>([])
  const [pods, setPods]                 = useState<CachedPod[]>([])
  const [loading, setLoading]           = useState(false)
  const [error, setError]               = useState<string | null>(null)
  const [selectedNode, setSelectedNode] = useState<string | null>(null)

  // Load connected cluster environments
  useEffect(() => {
    fetch('/api/environments')
      .then(r => r.json())
      .then((envs: Environment[]) => {
        const clusters = envs.filter(e => e.type === 'cluster' && e.gatewayUrl)
        setEnvironments(clusters)
        if (clusters.length === 1) setEnvId(clusters[0].id)
      })
      .catch(() => {})
  }, [])

  const fetchInfrastructure = useCallback(async (id: string) => {
    if (!id) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/environments/${id}/infrastructure`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const data = await res.json() as { nodes: CachedNode[]; pods: CachedPod[] }
      // Deserialise age strings back to Date objects
      setNodes(data.nodes)
      setPods(data.pods.map(p => ({ ...p, age: new Date(p.age) })))
      setSelectedNode(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (envId) fetchInfrastructure(envId)
    else { setNodes([]); setPods([]) }
  }, [envId, fetchInfrastructure])

  return (
    <div className="space-y-4 p-4 lg:p-6">
      {/* Toolbar */}
      <div className="flex items-center gap-2">
        <select
          value={envId}
          onChange={e => setEnvId(e.target.value)}
          className={selectCls}
          disabled={loading}
        >
          <option value="">Select environment…</option>
          {environments.map(e => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </select>

        {envId && (
          <button
            onClick={() => fetchInfrastructure(envId)}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-text-muted hover:text-text-primary border border-border-subtle hover:border-accent/50 disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        )}

        {loading && (
          <span className="text-xs text-text-muted">Loading…</span>
        )}
      </div>

      {/* Error state */}
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-3 text-sm text-status-error">
          <ServerCrash size={14} />
          <span>{error}</span>
        </div>
      )}

      {/* Empty state */}
      {!envId && !loading && (
        <div className="flex flex-col items-center justify-center py-16 text-text-muted">
          <ServerCrash size={32} className="mb-3 opacity-30" />
          <p className="text-sm">Select a cluster environment to view infrastructure</p>
        </div>
      )}

      {/* Data */}
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
