export const dynamic = 'force-dynamic'

import { prisma } from '@/lib/db'

export default async function AuditLogPage() {
  const entries = await prisma.auditLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
  })

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-text-primary">Audit Log</h1>
          <p className="text-sm text-text-muted mt-0.5">Last 100 recorded events</p>
        </div>
        <div className="flex gap-2">
          <a
            href="/api/admin/audit/export?format=json&limit=10000"
            className="text-xs px-3 py-1.5 rounded border border-border-subtle hover:bg-bg-raised transition-colors text-text-secondary"
          >
            Export JSON
          </a>
          <a
            href="/api/admin/audit/export?format=csv&limit=10000"
            className="text-xs px-3 py-1.5 rounded border border-border-subtle hover:bg-bg-raised transition-colors text-text-secondary"
          >
            Export CSV
          </a>
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="rounded-lg border border-border-subtle bg-bg-card px-4 py-10 text-center text-sm text-text-muted">
          No audit events recorded yet.
        </div>
      ) : (
        <div className="rounded-lg border border-border-subtle bg-bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-border-subtle bg-bg-raised">
              <tr>
                {['Time', 'User', 'Action', 'Target', 'Details'].map(h => (
                  <th key={h} className="text-left px-4 py-2.5 text-xs font-semibold text-text-muted">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {entries.map(e => (
                <tr key={e.id} className="hover:bg-bg-raised transition-colors">
                  <td className="px-4 py-2.5 text-text-muted font-mono text-xs whitespace-nowrap">
                    {new Date(e.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 text-accent text-xs font-mono">{e.userId}</td>
                  <td className="px-4 py-2.5">
                    <span className="text-xs px-2 py-0.5 rounded bg-status-warning/10 text-status-warning">
                      {e.action}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-text-secondary text-xs truncate max-w-[200px]">{e.target}</td>
                  <td className="px-4 py-2.5 text-text-muted text-xs font-mono truncate max-w-[200px]">
                    {e.detail ? JSON.stringify(e.detail) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
