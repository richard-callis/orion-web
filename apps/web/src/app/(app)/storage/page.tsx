import { customApi } from '@/lib/k8s'
import StorageBootstrapPanel from '@/components/infrastructure/StorageBootstrapPanel'
import StorageStatsPanel from '@/components/infrastructure/StorageStatsPanel'

export const dynamic = 'force-dynamic'

interface LonghornVolume {
  metadata: { name: string }
  spec: { numberOfReplicas: number; size: string }
  status: {
    state: string
    robustness: string
    currentNodeID?: string
    kubernetesStatus?: {
      namespace?: string
      pvcName?: string
      pvStatus?: string
      workloadsStatus?: Array<{ podName: string; podStatus: string; workloadName: string; workloadType: string }>
    }
  }
}

async function getLonghornVolumes(): Promise<LonghornVolume[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await customApi.listNamespacedCustomObject(
      'longhorn.io', 'v1beta2', 'kube-system', 'volumes'
    ) as any
    return res.body?.items ?? res.items ?? []
  } catch {
    return []
  }
}

function formatBytes(bytes: string | number): string {
  const n = typeof bytes === 'string' ? parseInt(bytes) : bytes
  if (!n) return '—'
  const gb = n / (1024 ** 3)
  return gb >= 1 ? `${gb.toFixed(0)}Gi` : `${(n / (1024 ** 2)).toFixed(0)}Mi`
}

const robustnessColor = (r: string) =>
  r === 'healthy'  ? 'text-status-healthy' :
  r === 'degraded' ? 'text-status-warning'  :
  r === 'faulted'  ? 'text-status-error'    : 'text-text-muted'

const stateColor = (s: string) =>
  s === 'attached' ? 'text-status-healthy' :
  s === 'detached' ? 'text-text-muted'     : 'text-status-warning'

export default async function StoragePage() {
  const volumes = await getLonghornVolumes()

  const healthy  = volumes.filter(v => v.status?.robustness === 'healthy').length
  const degraded = volumes.filter(v => v.status?.robustness === 'degraded').length
  const faulted  = volumes.filter(v => v.status?.robustness === 'faulted').length
  const unknown  = volumes.length - healthy - degraded - faulted

  return (
    <div className="space-y-4 p-4 lg:p-6">
      {/* Longhorn bootstrap */}
      <StorageBootstrapPanel />

      {/* Storage capacity stats */}
      <StorageStatsPanel />

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: 'Healthy',  count: healthy,  color: 'text-status-healthy border-status-healthy/30' },
          { label: 'Degraded', count: degraded, color: 'text-status-warning border-status-warning/30' },
          { label: 'Faulted',  count: faulted,  color: 'text-status-error border-status-error/30' },
          { label: 'Unknown',  count: unknown,  color: 'text-text-muted border-border-subtle' },
        ].map(({ label, count, color }) => (
          <div key={label} className={`rounded-lg border bg-bg-card p-4 ${color}`}>
            <p className="text-xs text-text-muted">{label} Volumes</p>
            <p className="text-2xl font-mono font-bold mt-1">{count}</p>
          </div>
        ))}
      </div>

      {/* Volume table */}
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
                    {workload ? (
                      <span title={workload.podName}>{workload.workloadName}</span>
                    ) : (
                      <span className="text-text-muted">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs font-mono text-text-muted">{formatBytes(v.spec?.size)}</td>
                  <td className={`px-3 py-2 text-xs font-medium ${stateColor(v.status?.state)}`}>{v.status?.state}</td>
                  <td className={`px-3 py-2 text-xs font-medium ${robustnessColor(v.status?.robustness)}`}>{v.status?.robustness}</td>
                  <td className="px-3 py-2 text-xs font-mono text-text-muted">{v.spec?.numberOfReplicas ?? '—'}</td>
                </tr>
              )
            })}
            {!volumes.length && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-text-muted text-sm">
                No Longhorn volumes found
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
