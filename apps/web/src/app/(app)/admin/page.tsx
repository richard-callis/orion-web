export const dynamic = 'force-dynamic'

import { prisma } from '@/lib/db'
import { headers } from 'next/headers'

async function getOverviewData() {
  const [userCount, modelCount, recentAudit, oidcProvider] = await Promise.all([
    prisma.user.count(),
    prisma.externalModel.count(),
    prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    prisma.oIDCProvider.findFirst(),
  ])

  return { userCount, modelCount, recentAudit, oidcProvider }
}

export default async function AdminOverviewPage() {
  const { userCount, modelCount, recentAudit, oidcProvider } = await getOverviewData()
  const h = headers()
  const ssoActive = !!h.get('x-authentik-username')

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-text-primary">Administration Overview</h1>
        <p className="text-sm text-text-muted mt-0.5">System status and configuration summary</p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Users" value={userCount} />
        <StatCard label="External Models" value={modelCount} />
        <StatCard
          label="SSO Status"
          value={ssoActive ? 'Active' : 'Inactive'}
          valueClass={ssoActive ? 'text-status-healthy' : 'text-status-error'}
        />
        <StatCard
          label="Auth Mode"
          value={oidcProvider?.headerMode !== false ? 'Header' : 'OIDC'}
        />
      </div>

      {/* Recent audit log */}
      <div className="rounded-lg border border-border-subtle bg-bg-card">
        <div className="px-4 py-3 border-b border-border-subtle">
          <h2 className="text-sm font-semibold text-text-primary">Recent Audit Events</h2>
        </div>
        {recentAudit.length === 0 ? (
          <p className="px-4 py-6 text-sm text-text-muted text-center">No audit events yet.</p>
        ) : (
          <div className="divide-y divide-border-subtle">
            {recentAudit.map((entry: any) => (
              <div key={entry.id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                <span className="text-text-muted font-mono text-xs w-40 flex-shrink-0">
                  {new Date(entry.createdAt).toLocaleString()}
                </span>
                <span className="text-accent text-xs w-28 flex-shrink-0 truncate">{entry.userId}</span>
                <span className="text-status-warning text-xs w-24 flex-shrink-0">{entry.action}</span>
                <span className="text-text-secondary truncate">{entry.target}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function StatCard({
  label,
  value,
  valueClass,
}: {
  label: string
  value: string | number
  valueClass?: string
}) {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-card p-4">
      <p className="text-xs text-text-muted mb-1">{label}</p>
      <p className={`text-2xl font-bold ${valueClass ?? 'text-text-primary'}`}>{value}</p>
    </div>
  )
}
