import { customApi } from '@/lib/k8s'

export const dynamic = 'force-dynamic'

export default async function SecretsPage() {
  let externalSecrets: Array<{ metadata: { name: string; namespace: string }; status?: { conditions?: Array<{ type: string; status: string; message?: string; lastTransitionTime?: string }> } }> = []
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (customApi as any).listClusterCustomObject('external-secrets.io', 'v1beta1', 'externalsecrets') as { items: typeof externalSecrets }
    externalSecrets = res.items ?? []
  } catch {}

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div className="rounded-lg border border-border-subtle bg-bg-card p-4">
        <h2 className="text-sm font-semibold text-text-secondary mb-3">External Secrets (ESO)</h2>
        <div className="rounded-lg border border-border-subtle overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg-raised border-b border-border-subtle">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Name</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Namespace</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Sync Status</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Last Synced</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {externalSecrets.map((es, i) => {
                const ready = es.status?.conditions?.find(c => c.type === 'Ready')
                return (
                  <tr key={i} className="hover:bg-bg-raised">
                    <td className="px-3 py-2 font-mono text-xs text-text-primary">{es.metadata.name}</td>
                    <td className="px-3 py-2 text-xs text-text-secondary">{es.metadata.namespace}</td>
                    <td className={`px-3 py-2 text-xs font-medium ${ready?.status === 'True' ? 'text-status-healthy' : 'text-status-error'}`}>
                      {ready?.status === 'True' ? 'Synced' : ready?.message ?? 'Unknown'}
                    </td>
                    <td className="px-3 py-2 text-xs font-mono text-text-muted">
                      {ready?.lastTransitionTime ? new Date(ready.lastTransitionTime).toLocaleString() : '—'}
                    </td>
                  </tr>
                )
              })}
              {!externalSecrets.length && (
                <tr><td colSpan={4} className="px-3 py-8 text-center text-text-muted text-sm">No ExternalSecrets found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
