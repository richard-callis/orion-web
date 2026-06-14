export const dynamic = 'force-dynamic'

import { prisma } from '@/lib/db'
import Link from 'next/link'

const ACTION_LABELS: Record<string, string> = {
  login:           'Login',
  logout:          'Logout',
  login_failed:    'Login failed',
  user_create:     'User created',
  user_update:     'User updated',
  user_delete:     'User deleted',
  model_create:    'Model created',
  model_update:    'Model updated',
  model_delete:    'Model deleted',
  tool_approve:    'Tool approved',
  tool_revoke:     'Tool revoked',
  settings_update: 'Settings updated',
  prompt_update:   'Prompt updated',
  api_key_create:  'API key created',
  api_key_revoke:  'API key revoked',
}

const ACTION_COLORS: Record<string, string> = {
  login:           'bg-emerald-500/10 text-emerald-400',
  logout:          'bg-bg-raised text-text-muted',
  login_failed:    'bg-red-500/10 text-red-400',
  user_delete:     'bg-red-500/10 text-red-400',
  model_delete:    'bg-red-500/10 text-red-400',
  api_key_revoke:  'bg-red-500/10 text-red-400',
  tool_revoke:     'bg-orange-500/10 text-orange-400',
  tool_approve:    'bg-emerald-500/10 text-emerald-400',
  settings_update: 'bg-blue-500/10 text-blue-400',
}

function actionColor(action: string): string {
  return ACTION_COLORS[action] ?? 'bg-status-warning/10 text-status-warning'
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; user?: string }>
}) {
  const { action, user } = await searchParams
  const actionFilter = action || undefined
  const userFilter   = user   || undefined

  // Fetch matching users if filtering by user substring
  const userIds = userFilter
    ? (await prisma.user.findMany({
        where: { OR: [{ username: { contains: userFilter, mode: 'insensitive' } }, { email: { contains: userFilter, mode: 'insensitive' } }] },
        select: { id: true },
      })).map(u => u.id)
    : undefined

  const entries = await prisma.auditLog.findMany({
    where: {
      ...(actionFilter ? { action: actionFilter } : {}),
      ...(userIds      ? { userId: { in: userIds } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })

  // Resolve user IDs → usernames in one query
  const uniqueUserIds = [...new Set(entries.map(e => e.userId).filter(Boolean) as string[])]
  const users = await prisma.user.findMany({
    where: { id: { in: uniqueUserIds } },
    select: { id: true, username: true },
  })
  const userMap = Object.fromEntries(users.map(u => [u.id, u.username]))

  // Available actions for the filter dropdown
  const allActions = Object.keys(ACTION_LABELS)

  const clearHref = '/admin/audit'

  return (
    <div className="p-6 space-y-5 max-w-6xl">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold text-text-primary">Audit Log</h1>
          <p className="text-sm text-text-muted mt-0.5">Last 200 events — filtered by action or user</p>
        </div>

        {/* Filters */}
        <form method="GET" className="flex items-center gap-2 flex-wrap">
          <select
            name="action"
            defaultValue={actionFilter ?? ''}
            className="text-xs px-2 py-1.5 rounded border border-border-subtle bg-bg-raised text-text-primary focus:outline-none focus:border-accent"
          >
            <option value="">All actions</option>
            {allActions.map(a => (
              <option key={a} value={a}>{ACTION_LABELS[a] ?? a}</option>
            ))}
          </select>
          <input
            name="user"
            defaultValue={userFilter ?? ''}
            placeholder="Username or email…"
            className="text-xs px-2 py-1.5 rounded border border-border-subtle bg-bg-raised text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent w-44"
          />
          <button
            type="submit"
            className="text-xs px-3 py-1.5 rounded border border-border-subtle bg-bg-raised text-text-primary hover:border-accent hover:text-accent transition-colors"
          >
            Filter
          </button>
          {(actionFilter || userFilter) && (
            <Link href={clearHref} className="text-xs text-text-muted hover:text-text-primary transition-colors">
              Clear
            </Link>
          )}
        </form>
      </div>

      {entries.length === 0 ? (
        <div className="rounded-lg border border-border-subtle bg-bg-card px-4 py-10 text-center text-sm text-text-muted">
          No audit events match the current filter.
        </div>
      ) : (
        <div className="rounded-lg border border-border-subtle bg-bg-card overflow-hidden overflow-x-auto">
          <table className="w-full text-sm min-w-[700px]">
            <thead className="border-b border-border-subtle bg-bg-raised">
              <tr>
                {['Time', 'User', 'Action', 'Target', 'IP', 'Details'].map(h => (
                  <th key={h} className="text-left px-4 py-2.5 text-xs font-semibold text-text-muted whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {entries.map((e: any) => (
                <tr key={e.id} className="hover:bg-bg-raised transition-colors">
                  <td className="px-4 py-2.5 text-text-muted font-mono text-xs whitespace-nowrap">
                    {new Date(e.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 text-accent text-xs font-mono">
                    {userMap[e.userId] ?? e.userId?.slice(0, 8) ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <span className={`text-xs px-2 py-0.5 rounded ${actionColor(e.action)}`}>
                      {ACTION_LABELS[e.action] ?? e.action}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-text-secondary text-xs truncate max-w-[180px]">{e.target ?? '—'}</td>
                  <td className="px-4 py-2.5 text-text-muted text-xs font-mono whitespace-nowrap">{e.ipAddress ?? '—'}</td>
                  <td className="px-4 py-2.5 text-text-muted text-xs font-mono truncate max-w-[200px]">
                    {e.detail ? JSON.stringify(e.detail) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] text-text-muted">
        Showing up to 200 most recent events. Full export available via <span className="font-mono text-accent">/admin/audit-export</span>.
      </p>
    </div>
  )
}
