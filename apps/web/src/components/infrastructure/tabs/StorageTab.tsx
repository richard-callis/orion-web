'use client'

import useSWR from 'swr'
import { errorMessage } from '@/lib/api'
import { RefreshCw, ServerCrash, HardDrive } from 'lucide-react'
import type { LonghornVolume, StorageStats } from '../types'

export function formatBytes(bytes: string | number): string {
  const n = typeof bytes === 'string' ? parseInt(bytes) : bytes
  if (!n) return '—'
  const gb = n / (1024 ** 3)
  return gb >= 1 ? `${gb.toFixed(0)}Gi` : `${(n / (1024 ** 2)).toFixed(0)}Mi`
}

export const robustnessColor = (r: string) =>
  r === 'healthy' ? 'text-status-healthy' :
  r === 'degraded' ? 'text-status-warning' :
  r === 'faulted' ? 'text-status-error' : 'text-text-muted'

export const stateColor = (s: string) =>
  s === 'attached' ? 'text-status-healthy' :
  s === 'detached' ? 'text-text-muted' : 'text-status-warning'

export function formatStorageBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

export function CapacityBar({ total, used, free }: { total: number; used: number; free: number }) {
  const usedPct = total > 0 ? (used / total) * 100 : 0
  const color = usedPct > 85 ? 'bg-status-error' : usedPct > 65 ? 'bg-status-warning' : 'bg-status-healthy'
  return (
    <div className="space-y-1.5">
      <div className="h-2 w-full rounded-full bg-bg-raised overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${usedPct.toFixed(1)}%` }} />
      </div>
      <div className="flex justify-between text-[10px] font-mono text-text-muted">
        <span className="text-status-error">{formatStorageBytes(used)} used</span>
        <span>{usedPct.toFixed(1)}%</span>
        <span className="text-status-healthy">{formatStorageBytes(free)} free</span>
      </div>
    </div>
  )
}

export function StorageTab({ envId }: { envId: string }) {
  // Keyed on envId — responses for a previously selected environment are dropped by SWR.
  const volKey = envId ? `/api/environments/${envId}/storage` : null
  const { data: volData, error: volError, isValidating, mutate: reloadVolumes } =
    useSWR<{ volumes?: LonghornVolume[] }>(volKey, { revalidateOnFocus: false })
  // Stats are best-effort: a failure just hides the capacity panel.
  const { data: stats, mutate: reloadStats } =
    useSWR<StorageStats>(envId ? `/api/environments/${envId}/storage-stats` : null, { revalidateOnFocus: false, shouldRetryOnError: false })
  const volumes = volData?.volumes ?? []
  const loading = isValidating
  const error = volError ? errorMessage(volError) : null
  const load = () => { void reloadVolumes(); void reloadStats() }

  const healthy = volumes.filter(v => v.status?.robustness === 'healthy').length
  const degraded = volumes.filter(v => v.status?.robustness === 'degraded').length
  const faulted = volumes.filter(v => v.status?.robustness === 'faulted').length
  const unknown = volumes.length - healthy - degraded - faulted

  if (!envId) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-text-muted">
        <HardDrive size={32} className="mb-3 opacity-30" />
        <p className="text-sm">Select a cluster environment using the selector above</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-text-primary">Longhorn Volumes</h2>
          {stats?.provider && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-sm border border-accent/30 bg-accent/5 text-accent font-mono capitalize">{stats.provider}</span>
          )}
        </div>
        <button onClick={load} disabled={loading} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-text-muted hover:text-text-primary border border-border-subtle hover:border-accent/50 disabled:opacity-50 transition-colors">
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-3 text-sm text-status-error">
          <ServerCrash size={14} />
          <span>{error}</span>
        </div>
      )}

      {/* Capacity stats */}
      {stats?.provider && stats.totalBytes > 0 && (
        <div className="rounded-lg border border-border-subtle bg-bg-card p-4 space-y-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-text-secondary">Cluster Capacity</span>
            <span className="font-mono text-text-primary">{formatStorageBytes(stats.totalBytes)} total</span>
          </div>
          <CapacityBar total={stats.totalBytes} used={stats.usedBytes} free={stats.freeBytes} />
          {stats.nodes.length > 0 && (
            <div className="pt-2 border-t border-border-subtle space-y-2">
              <p className="text-[10px] text-text-muted font-medium">Per node</p>
              {stats.nodes.map(n => {
                const pct = n.totalBytes > 0 ? (n.usedBytes / n.totalBytes) * 100 : 0
                const color = pct > 85 ? 'bg-status-error' : pct > 65 ? 'bg-status-warning' : 'bg-accent'
                return (
                  <div key={n.name} className="space-y-0.5">
                    <div className="flex justify-between text-[10px] font-mono">
                      <span className="text-text-primary">{n.name}</span>
                      <span className="text-text-muted">{formatStorageBytes(n.totalBytes)}</span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-bg-raised overflow-hidden">
                      <div className={`h-full rounded-full ${color}`} style={{ width: `${pct.toFixed(1)}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-4 gap-4">
        {[
          { label: 'Healthy', count: healthy, color: 'text-status-healthy border-status-healthy/30' },
          { label: 'Degraded', count: degraded, color: 'text-status-warning border-status-warning/30' },
          { label: 'Faulted', count: faulted, color: 'text-status-error border-status-error/30' },
          { label: 'Unknown', count: unknown, color: 'text-text-muted border-border-subtle' },
        ].map(({ label, count, color }) => (
          <div key={label} className={`rounded-lg border bg-bg-card p-4 ${color}`}>
            <p className="text-xs text-text-muted">{label} Volumes</p>
            <p className="text-2xl font-mono font-bold mt-1">{count}</p>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-border-subtle overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-bg-raised border-b border-border-subtle">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Claim</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Namespace</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Workload</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Size</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">State</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Robustness</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Replicas</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {volumes.map(v => {
              const ks = v.status?.kubernetesStatus
              const workload = ks?.workloadsStatus?.[0]
              return (
                <tr key={v.metadata.name} className="hover:bg-bg-raised">
                  <td className="px-3 py-2 text-xs text-text-primary font-medium max-w-[200px] truncate">
                    {ks?.pvcName ?? <span className="text-text-muted font-mono text-[10px]">{v.metadata.name.slice(0, 16)}…</span>}
                  </td>
                  <td className="px-3 py-2 text-xs text-text-secondary">{ks?.namespace ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-text-secondary max-w-[160px] truncate">
                    {workload ? <span title={workload.podName}>{workload.workloadName}</span> : <span className="text-text-muted">—</span>}
                  </td>
                  <td className="px-3 py-2 text-xs font-mono text-text-muted">{formatBytes(v.spec?.size)}</td>
                  <td className={`px-3 py-2 text-xs font-medium ${stateColor(v.status?.state)}`}>{v.status?.state}</td>
                  <td className={`px-3 py-2 text-xs font-medium ${robustnessColor(v.status?.robustness)}`}>{v.status?.robustness}</td>
                  <td className="px-3 py-2 text-xs font-mono text-text-muted">{v.spec?.numberOfReplicas ?? '—'}</td>
                </tr>
              )
            })}
            {!volumes.length && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-text-muted text-sm">No Longhorn volumes found</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Secrets tab ────────────────────────────────────────────────────────────────
