'use client'
import { useState } from 'react'
import { Trash2, RefreshCw } from 'lucide-react'

interface User {
  id: string
  username: string
  name: string | null
  email: string
  role: string
  provider: string
  lastSeen: string | null
  active: boolean
  createdAt: string
}

const ROLES = ['admin', 'user', 'readonly']

export function UsersClient({ initialUsers }: { initialUsers: User[] }) {
  const [users, setUsers] = useState<User[]>(initialUsers)
  const [busy, setBusy] = useState<Record<string, boolean>>({})

  const patch = async (id: string, data: Partial<User>) => {
    setBusy(b => ({ ...b, [id]: true }))
    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (res.ok) {
        const updated: User = await res.json()
        setUsers(prev => prev.map(u => u.id === id ? updated : u))
      }
    } finally {
      setBusy(b => ({ ...b, [id]: false }))
    }
  }

  const deleteUser = async (id: string) => {
    if (!confirm('Delete this user? They will be re-created on next login.')) return
    setBusy(b => ({ ...b, [id]: true }))
    const res = await fetch(`/api/admin/users/${id}`, { method: 'DELETE' })
    if (res.ok) setUsers(prev => prev.filter(u => u.id !== id))
    setBusy(b => ({ ...b, [id]: false }))
  }

  if (users.length === 0) {
    return (
      <div className="rounded-lg border border-border-subtle bg-bg-card px-4 py-10 text-center text-sm text-text-muted">
        No users yet. Users are created on first login.
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="border-b border-border-subtle bg-bg-raised">
          <tr>
            {['Username', 'Name', 'Email', 'Role', 'Provider', 'Last Seen', 'Active', ''].map(h => (
              <th key={h} className="text-left px-4 py-2.5 text-xs font-semibold text-text-muted">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {users.map(u => (
            <tr key={u.id} className="hover:bg-bg-raised transition-colors">
              <td className="px-4 py-3 font-medium text-text-primary font-mono text-xs">{u.username}</td>
              <td className="px-4 py-3 text-text-secondary">{u.name ?? '—'}</td>
              <td className="px-4 py-3 text-text-muted text-xs truncate max-w-[180px]">{u.email || '—'}</td>
              <td className="px-4 py-3">
                <select
                  value={u.role}
                  onChange={e => patch(u.id, { role: e.target.value })}
                  disabled={busy[u.id]}
                  className="px-2 py-1 text-xs bg-bg-raised border border-border-subtle rounded text-text-primary focus:outline-none focus:border-accent transition-colors"
                >
                  {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </td>
              <td className="px-4 py-3">
                <span className="text-xs px-2 py-0.5 rounded bg-bg-raised text-text-muted">{u.provider}</span>
              </td>
              <td className="px-4 py-3 text-text-muted text-xs">
                {u.lastSeen ? new Date(u.lastSeen).toLocaleDateString() : 'Never'}
              </td>
              <td className="px-4 py-3">
                <button
                  onClick={() => patch(u.id, { active: !u.active })}
                  disabled={busy[u.id]}
                  title="Toggle active"
                >
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                    u.active
                      ? 'bg-status-healthy/15 text-status-healthy'
                      : 'bg-status-error/15 text-status-error'
                  }`}>
                    {u.active ? 'Active' : 'Inactive'}
                  </span>
                </button>
              </td>
              <td className="px-4 py-3">
                <button
                  onClick={() => deleteUser(u.id)}
                  disabled={busy[u.id]}
                  className="p-1 rounded text-text-muted hover:text-status-error transition-colors disabled:opacity-50"
                  title="Delete user"
                >
                  {busy[u.id] ? <RefreshCw size={13} className="animate-spin" /> : <Trash2 size={13} />}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
