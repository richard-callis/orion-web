'use client'

import useSWR from 'swr'
import { errorMessage } from '@/lib/api'

interface K8sEvent {
  metadata?: { uid?: string; name?: string; namespace?: string }
  involvedObject?: { name?: string }
  reason?: string
  message?: string
  count?: number
  lastTimestamp?: string
}

export function AlertsTab() {
  const { data, error, isLoading } = useSWR<K8sEvent[] | { items?: K8sEvent[] }>('/api/k8s/events?type=Warning&limit=100')
  const events = Array.isArray(data) ? data : (data?.items ?? [])

  if (isLoading) return <div className="p-6 text-sm text-text-muted" role="status">Loading alerts…</div>
  if (error) return <div className="p-6 text-sm text-status-error" role="alert">Failed to load alerts: {errorMessage(error)}</div>

  return (
    <div className="space-y-4 p-4">
      <p className="text-sm text-text-muted">Showing last {events.length} Warning events cluster-wide</p>
      <div className="rounded-lg border border-border-subtle overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-bg-raised border-b border-border-subtle">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Time</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Namespace</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Object</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Reason</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Message</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted w-12">Count</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {events.map((e, i) => (
              <tr key={e.metadata?.uid ?? `${e.metadata?.namespace}/${e.metadata?.name}/${i}`} className="hover:bg-bg-raised">
                <td className="px-3 py-2 text-xs font-mono text-text-muted whitespace-nowrap">
                  {e.lastTimestamp ? new Date(e.lastTimestamp).toLocaleString() : '—'}
                </td>
                <td className="px-3 py-2 text-xs text-text-secondary">{e.metadata?.namespace}</td>
                <td className="px-3 py-2 text-xs font-mono text-text-primary max-w-[160px] truncate">{e.involvedObject?.name}</td>
                <td className="px-3 py-2 text-xs text-status-warning font-medium">{e.reason}</td>
                <td className="px-3 py-2 text-xs text-text-secondary max-w-[300px] truncate" title={e.message}>{e.message}</td>
                <td className="px-3 py-2 text-xs font-mono text-text-muted">{e.count}</td>
              </tr>
            ))}
            {!events.length && (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-status-healthy text-sm">No Warning events — cluster looks healthy</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
