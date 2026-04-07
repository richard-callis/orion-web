import { coreApi } from '@/lib/k8s'

export const dynamic = 'force-dynamic'

export default async function AlertsPage() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let events: any[] = []
  try {
    const res = await coreApi.listEventForAllNamespaces()
    const items: any[] = res.body?.items ?? res.items ?? []
    events = items
      .filter((e: any) => e.type === 'Warning')
      .sort((a: any, b: any) => {
        const ta = a.lastTimestamp instanceof Date ? a.lastTimestamp.getTime() : new Date(a.lastTimestamp ?? 0).getTime()
        const tb = b.lastTimestamp instanceof Date ? b.lastTimestamp.getTime() : new Date(b.lastTimestamp ?? 0).getTime()
        return tb - ta
      })
      .slice(0, 100)
  } catch {}

  return (
    <div className="space-y-4 p-4 lg:p-6">
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
              <tr key={i} className="hover:bg-bg-raised">
                <td className="px-3 py-2 text-xs font-mono text-text-muted whitespace-nowrap">
                  {e.lastTimestamp ? new Date(e.lastTimestamp).toLocaleString() : '—'}
                </td>

                <td className="px-3 py-2 text-xs text-text-secondary">{e.metadata.namespace}</td>
                <td className="px-3 py-2 text-xs font-mono text-text-primary max-w-[160px] truncate">{e.involvedObject.name}</td>
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
