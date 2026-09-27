'use client'
import { useState } from 'react'
import { Trash2, RefreshCw, UserPlus, KeyRound } from 'lucide-react'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { useToast } from '@/components/ui/Toast'
import { Dialog } from '@/components/ui/Dialog'

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
const MIN_PASSWORD = 12

const inputCls = 'w-full px-2.5 py-1.5 rounded border border-border-visible bg-bg-raised text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-accent'

async function errorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({})) as { error?: string; details?: Array<{ field?: string; message: string }> }
  if (body.details?.length) return body.details.map(d => (d.field ? `${d.field}: ${d.message}` : d.message)).join('; ')
  return body.error ?? `HTTP ${res.status}`
}

export function UsersClient({ initialUsers }: { initialUsers: User[] }) {
  const confirmDialog = useConfirm()
  const toast = useToast()
  const [users, setUsers] = useState<User[]>(initialUsers)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [creating, setCreating] = useState(false)
  const [pwUser, setPwUser] = useState<User | null>(null)

  const patch = async (id: string, data: Partial<User> & { password?: string }): Promise<boolean> => {
    setBusy(b => ({ ...b, [id]: true }))
    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) {
        toast.error(`Update failed: ${await errorMessage(res)}`)
        return false
      }
      const updated: User = await res.json()
      setUsers(prev => prev.map(u => u.id === id ? { ...u, ...updated } : u))
      return true
    } catch (e) {
      toast.error(`Update failed: ${e instanceof Error ? e.message : String(e)}`)
      return false
    } finally {
      setBusy(b => ({ ...b, [id]: false }))
    }
  }

  const deleteUser = async (u: User) => {
    const message = u.provider === 'local'
      ? `Delete ${u.username}? This cannot be undone.`
      : `Delete ${u.username}? They will be re-created on their next ${u.provider} login.`
    if (!(await confirmDialog({ title: 'Delete user?', message, confirmLabel: 'Delete' }))) return
    setBusy(b => ({ ...b, [u.id]: true }))
    try {
      const res = await fetch(`/api/admin/users/${u.id}`, { method: 'DELETE' })
      if (res.ok) setUsers(prev => prev.filter(x => x.id !== u.id))
      else toast.error(`Delete failed: ${await errorMessage(res)}`)
    } finally {
      setBusy(b => ({ ...b, [u.id]: false }))
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-accent/15 text-accent hover:bg-accent/25 border border-accent/30 transition-colors"
        >
          <UserPlus size={13} /> Add user
        </button>
      </div>

      {users.length === 0 ? (
        <div className="rounded-lg border border-border-subtle bg-bg-card px-4 py-10 text-center text-sm text-text-muted">
          No users yet. Add a local user above, or users are created on their first SSO login.
        </div>
      ) : (
        <div className="rounded-lg border border-border-subtle bg-bg-card overflow-x-auto">
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
                      aria-label={`Role for ${u.username}`}
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
                      aria-label={`${u.active ? 'Deactivate' : 'Activate'} ${u.username}`}
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
                    <div className="flex items-center gap-1">
                      {u.provider === 'local' && (
                        <button
                          onClick={() => setPwUser(u)}
                          disabled={busy[u.id]}
                          className="p-1 rounded text-text-muted hover:text-accent transition-colors disabled:opacity-50"
                          title="Set password"
                          aria-label={`Set password for ${u.username}`}
                        >
                          <KeyRound size={13} />
                        </button>
                      )}
                      <button
                        onClick={() => deleteUser(u)}
                        disabled={busy[u.id]}
                        className="p-1 rounded text-text-muted hover:text-status-error transition-colors disabled:opacity-50"
                        title="Delete user"
                        aria-label={`Delete ${u.username}`}
                      >
                        {busy[u.id] ? <RefreshCw size={13} className="animate-spin" /> : <Trash2 size={13} />}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <CreateUserDialog
          onClose={() => setCreating(false)}
          onCreated={u => {
            setUsers(prev => [u, ...prev])
            setCreating(false)
            toast.success(`User ${u.username} created`)
          }}
        />
      )}

      {pwUser && (
        <SetPasswordDialog
          user={pwUser}
          onClose={() => setPwUser(null)}
          onSave={async pw => {
            const ok = await patch(pwUser.id, { password: pw })
            if (ok) {
              toast.success(`Password updated for ${pwUser.username}`)
              setPwUser(null)
            }
            return ok
          }}
        />
      )}
    </div>
  )
}

function CreateUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (u: User) => void }) {
  const [form, setForm] = useState({ username: '', name: '', email: '', password: '', confirm: '', role: 'user' })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!/^[a-zA-Z0-9_-]{3,100}$/.test(form.username)) { setError('Username must be 3+ characters: letters, numbers, _ or -'); return }
    if (form.password.length < MIN_PASSWORD) { setError(`Password must be at least ${MIN_PASSWORD} characters`); return }
    if (form.password !== form.confirm) { setError('Passwords do not match'); return }
    setSaving(true); setError(null)
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: form.username,
          email: form.email,
          password: form.password,
          role: form.role,
          ...(form.name.trim() && { name: form.name.trim() }),
        }),
      })
      if (!res.ok) { setError(await errorMessage(res)); return }
      const created = await res.json() as Omit<User, 'lastSeen' | 'createdAt'> & { lastSeen: string | null; createdAt: string }
      onCreated(created as User)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog onClose={onClose} labelledBy="create-user-title" className="w-full max-w-md">
      <form onSubmit={submit} className="p-5 space-y-3">
        <h2 id="create-user-title" className="text-sm font-semibold text-text-primary">Add local user</h2>
        <label className="block space-y-1">
          <span className="text-xs text-text-muted">Username</span>
          <input className={inputCls} value={form.username} onChange={set('username')} autoComplete="off" required autoFocus />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-text-muted">Name (optional)</span>
          <input className={inputCls} value={form.name} onChange={set('name')} autoComplete="off" />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-text-muted">Email</span>
          <input className={inputCls} type="email" value={form.email} onChange={set('email')} autoComplete="off" required />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block space-y-1">
            <span className="text-xs text-text-muted">Password</span>
            <input className={inputCls} type="password" value={form.password} onChange={set('password')} autoComplete="new-password" required minLength={MIN_PASSWORD} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-text-muted">Confirm</span>
            <input className={inputCls} type="password" value={form.confirm} onChange={set('confirm')} autoComplete="new-password" required />
          </label>
        </div>
        <p className="text-[10px] text-text-muted">At least {MIN_PASSWORD} characters.</p>
        <label className="block space-y-1">
          <span className="text-xs text-text-muted">Role</span>
          <select className={inputCls} value={form.role} onChange={set('role')}>
            {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        {error && <p role="alert" className="text-xs text-status-error">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded text-xs border border-border-subtle text-text-muted hover:text-text-primary">Cancel</button>
          <button type="submit" disabled={saving} className="px-4 py-1.5 rounded text-xs bg-accent/15 text-accent hover:bg-accent/25 border border-accent/30 disabled:opacity-50">
            {saving ? 'Creating…' : 'Create user'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function SetPasswordDialog({ user, onClose, onSave }: { user: User; onClose: () => void; onSave: (pw: string) => Promise<boolean> }) {
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (pw.length < MIN_PASSWORD) { setError(`Password must be at least ${MIN_PASSWORD} characters`); return }
    if (pw !== confirm) { setError('Passwords do not match'); return }
    setSaving(true); setError(null)
    const ok = await onSave(pw)
    setSaving(false)
    if (!ok) setError('Password was not updated')
  }

  return (
    <Dialog onClose={onClose} labelledBy="set-pw-title" className="w-full max-w-sm">
      <form onSubmit={submit} className="p-5 space-y-3">
        <h2 id="set-pw-title" className="text-sm font-semibold text-text-primary">Set password for <span className="font-mono">{user.username}</span></h2>
        <label className="block space-y-1">
          <span className="text-xs text-text-muted">New password</span>
          <input className={inputCls} type="password" value={pw} onChange={e => setPw(e.target.value)} autoComplete="new-password" required minLength={MIN_PASSWORD} autoFocus />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-text-muted">Confirm</span>
          <input className={inputCls} type="password" value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" required />
        </label>
        {error && <p role="alert" className="text-xs text-status-error">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded text-xs border border-border-subtle text-text-muted hover:text-text-primary">Cancel</button>
          <button type="submit" disabled={saving} className="px-4 py-1.5 rounded text-xs bg-accent/15 text-accent hover:bg-accent/25 border border-accent/30 disabled:opacity-50">
            {saving ? 'Saving…' : 'Set password'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
