import { KpiCard } from '@/components/dashboard/KpiCard'
import { coreApi, appsApi } from '@/lib/k8s'

async function getDashboardData() {
  try {
    const [pods, nodes, deployments] = await Promise.all([
      coreApi.listPodForAllNamespaces(),
      coreApi.listNode(),
      appsApi.listDeploymentForAllNamespaces(),
    ])

    // v0.22 returns { response, body } — support both shapes
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const podList: any[] = pods.body?.items ?? pods.items ?? []
    const running   = podList.filter((p: any) => p.status?.phase === 'Running').length
    const failed    = podList.filter((p: any) => p.status?.phase === 'Failed').length
    const pending   = podList.filter((p: any) => p.status?.phase === 'Pending').length

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodeList: any[] = nodes.body?.items ?? nodes.items ?? []
    const nodesReady = nodeList.filter((n: any) =>
      n.status?.conditions?.find((c: any) => c.type === 'Ready')?.status === 'True'
    ).length

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const depList: any[] = deployments.body?.items ?? deployments.items ?? []
    const depHealthy = depList.filter((d: any) => d.status?.availableReplicas === d.status?.replicas).length

    return { running, failed, pending, total: podList.length, nodesReady, nodeTotal: nodeList.length, depHealthy, depTotal: depList.length }
  } catch {
    return null
  }
}

export default async function DashboardPage() {
  const data = await getDashboardData()

  return (
    <div className="space-y-6 p-4 lg:p-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Pods Running"   value={data?.running ?? '—'} total={data?.total}    color="healthy" />
        <KpiCard label="Pods Failed"    value={data?.failed ?? '—'}  color={data?.failed ? 'error' : 'healthy'} />
        <KpiCard label="Nodes Ready"    value={data?.nodesReady ?? '—'} total={data?.nodeTotal} color="healthy" />
        <KpiCard label="Deployments"    value={data?.depHealthy ?? '—'} total={data?.depTotal}  color="healthy" />
      </div>

      {data?.failed ? (
        <div className="rounded-lg border border-status-error/40 bg-status-error/10 p-4 text-sm text-status-error">
          ⚠ {data.failed} pod{data.failed > 1 ? 's' : ''} in Failed state — check{' '}
          <a href="/infrastructure" className="underline">Infrastructure</a>
        </div>
      ) : null}

      {data?.pending ? (
        <div className="rounded-lg border border-status-warning/40 bg-status-warning/10 p-4 text-sm text-status-warning">
          ⏳ {data.pending} pod{data.pending > 1 ? 's' : ''} Pending
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-lg border border-border-subtle bg-bg-card p-4">
          <h2 className="text-sm font-semibold mb-3 text-text-secondary">Quick Links</h2>
          <div className="grid grid-cols-2 gap-2 text-sm">
            {[
              ['/infrastructure', 'Infrastructure'],
              ['/storage',        'Longhorn Storage'],
              ['/chat',           'Claude Chat'],
              ['/dns',            'DNS Manager'],
              ['/alerts',         'Alerts'],
              ['/logs',           'Pod Logs'],
            ].map(([href, label]) => (
              <a key={href} href={href} className="px-3 py-2 rounded bg-bg-raised hover:bg-accent/15 hover:text-accent transition-colors text-text-secondary">
                {label} →
              </a>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-border-subtle bg-bg-card p-4">
          <h2 className="text-sm font-semibold mb-3 text-text-secondary">Cluster Info</h2>
          <dl className="space-y-1 text-sm font-mono">
            {[
              ['Nodes',      `${data?.nodesReady ?? '—'}/${data?.nodeTotal ?? '—'} Ready`],
              ['Pods',       `${data?.running ?? '—'} running`],
              ['Storage',    'Longhorn 2x replication'],
              ['Ingress',    'Traefik + cert-manager'],
              ['Auth',       'Authentik SSO'],
            ].map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <dt className="text-text-muted w-20 flex-shrink-0">{k}</dt>
                <dd className="text-text-primary">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  )
}
