'use client'

import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, HardDrive, Database } from 'lucide-react'
import type { StorageStats, StorageNode } from '@/app/api/environments/[id]/storage-stats/route'

interface Environment {
  id: string
  name: string
  type: string
  gatewayUrl: string | null
}

const selectCls = 'text-xs bg-bg-raised border border-border-subtle rounded-lg px-2 py-1.5 text-text-primary focus:outline-none focus:ring-1 focus:ring-accent'

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

function UsageBar({ total, used, free }: { total: number; used: number; free: number }) {
  const usedPct = total > 0 ? (used / total) * 100 : 0
  const color = usedPct > 85 ? 'bg-status-error' : usedPct > 65 ? 'bg-status-warning' : 'bg-status-healthy'

  return (
    <div className="space-y-1.5">
      <div className="h-2 w-full rounded-full bg-bg-raised overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${usedPct.toFixed(1)}%` }} />
      </div>
      <div className="flex justify-between text-[10px] font-mono text-text-muted">
        <span className="text-status-error">{formatBytes(used)} used</span>
        <span>{usedPct.toFixed(1)}%</span>
        <span className="text-status-healthy">{formatBytes(free)} free</span>
      </div>
    </div>
  )
}

function NodeRow({ node }: { node: StorageNode }) {
  const pct = node.totalBytes > 0 ? (node.usedBytes / node.totalBytes) * 100 : 0
  const color = pct > 85 ? 'bg-status-error' : pct > 65 ? 'bg-status-warning' : 'bg-accent'

  return (
    <div className="space-y-1">
      <div className="flex justify-between items-center">
        <span className="text-[11px] font-medium text-text-primary font-mono">{node.name}</span>
        <span className="text-[10px] text-text-muted font-mono">{formatBytes(node.totalBytes)}</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-bg-raised overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct.toFixed(1)}%` }} />
      </div>
      <div className="flex justify-between text-[10px] text-text-muted font-mono">
        <span>{formatBytes(node.usedBytes)} used</span>
        <span>{formatBytes(node.freeBytes)} free</span>
      </div>
    </div>
  )
}

export default function StorageStatsPanel() {
  const [environments, setEnvironments] = useState<Environment[]>([])
  const [envId, setEnvId]               = useState('')
  const [stats, setStats]               = useState<StorageStats | null>(null)
  const [loading, setLoading]           = useState(false)
  const [error, setError]               = useState<string | null>(null)

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

  const fetchStats = useCallback(async (id: string) => {
    if (!id) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/environments/${id}/storage-stats`)
      const data = await res.json() as StorageStats & { error?: string }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      setStats(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStats(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (envId) fetchStats(envId)
    else setStats(null)
  }, [envId, fetchStats])

  if (environments.length === 0) return null

  const providerLabel = stats?.provider === 'longhorn' ? 'Longhorn'
    : stats?.provider === 'ceph' ? 'Rook-Ceph'
    : null

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-card p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <HardDrive size={13} className="text-accent" />
          <span className="text-sm font-semibold text-text-primary">Storage Capacity</span>
          {providerLabel && (
            <span className="text-[10px] px-1.5 py-0.5 rounded border border-accent/30 bg-accent/5 text-accent font-mono">
              {providerLabel}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <select value={envId} onChange={e => setEnvId(e.target.value)} className={selectCls} disabled={loading}>
            <option value="">Select environment…</option>
            {environments.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
          {envId && (
            <button
              onClick={() => fetchStats(envId)}
              disabled={loading}
              className="p-1.5 rounded text-text-muted hover:text-text-primary disabled:opacity-50 transition-colors"
            >
              <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            </button>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <p className="text-xs text-status-error">{error}</p>
      )}

      {/* No provider */}
      {stats && !stats.provider && (
        <p className="text-xs text-text-muted italic">No storage provider detected in this environment.</p>
      )}

      {/* Stats */}
      {stats?.provider && stats.totalBytes > 0 && (
        <>
          {/* Cluster-wide totals */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-text-secondary">Cluster Total</span>
              <span className="text-xs font-mono text-text-primary">{formatBytes(stats.totalBytes)}</span>
            </div>
            <UsageBar total={stats.totalBytes} used={stats.usedBytes} free={stats.freeBytes} />
          </div>

          {/* Per-node breakdown (Longhorn) */}
          {stats.nodes.length > 0 && (
            <div className="space-y-3 pt-1 border-t border-border-subtle">
              <div className="flex items-center gap-1.5 text-xs text-text-muted">
                <Database size={10} />
                <span>Per node</span>
              </div>
              {stats.nodes.map(node => (
                <NodeRow key={node.name} node={node} />
              ))}
            </div>
          )}
        </>
      )}

      {/* Empty / no env selected */}
      {!envId && !loading && (
        <p className="text-xs text-text-muted italic">Select an environment to view storage capacity.</p>
      )}
    </div>
  )
}
