'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Plus, Users, X } from 'lucide-react'
import { Button, IconButton } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { useToast } from '@/components/ui/Toast'
import { apiFetch, errorMessage } from '@/lib/api'
import { EmptyCard, LoadingBlock } from '../shared'
import { TIERS, type AllUser, type Environment, type UserTier } from '../types'

const TIER_BUTTON: Record<string, string> = {
  admin: 'border-orange-500/30 text-orange-400 hover:bg-orange-500/10',
  operator: 'border-blue-500/30 text-blue-400 hover:bg-blue-500/10',
  viewer: 'border-border-subtle text-text-muted hover:bg-bg-raised',
}

export function AccessTab({ env }: { env: Environment }) {
  const toast = useToast()
  const tiersKey = `/api/environments/${env.id}/user-tiers`
  const { data: tiers, mutate } = useSWR<UserTier[]>(tiersKey)
  const { data: users = [] } = useSWR<AllUser[]>('/api/admin/users', { revalidateOnFocus: false })
  const [showAdd, setShowAdd] = useState(false)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)

  const setTier = async (userId: string, tier: string) => {
    setBusy(true)
    try {
      await apiFetch(tiersKey, { method: 'PUT', body: { userId, tier } })
    } catch (e) {
      toast.error(`Failed to update access tier: ${errorMessage(e)}`)
    } finally {
      await mutate()
      setBusy(false)
    }
  }

  const removeTier = async (userId: string) => {
    try {
      await apiFetch(`${tiersKey}?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' })
      await mutate(prev => prev?.filter(t => t.userId !== userId), { revalidate: false })
    } catch (e) {
      toast.error(`Failed to remove access tier: ${errorMessage(e)}`)
    }
  }

  const q = search.toLowerCase()
  const candidates = users.filter(u =>
    !(tiers ?? []).some(t => t.userId === u.id) &&
    (u.username.toLowerCase().includes(q) || (u.name ?? '').toLowerCase().includes(q)),
  )

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-text-primary">User Access Tiers</p>
          <p className="text-xs text-text-muted mt-0.5">Control which users can run restricted tools in this environment</p>
        </div>
        <Button onClick={() => { setShowAdd(true); setSearch('') }}>
          <Plus size={12} aria-hidden /> Assign User
        </Button>
      </div>

      <div className="rounded-lg border border-border-subtle bg-bg-card p-3 space-y-1 text-xs text-text-muted">
        <p><strong className="text-text-secondary">viewer</strong> — can read (default for all users with no explicit tier)</p>
        <p><strong className="text-text-secondary">operator</strong> — can run operator-level tools without approval</p>
        <p><strong className="text-text-secondary">admin</strong> — full access, can run all tools without approval</p>
        <p className="text-[11px] mt-1">Users not listed here default to <em>viewer</em>. Admins in ORION always have admin tier everywhere.</p>
      </div>

      {showAdd && (
        <div className="rounded-lg border border-border-subtle bg-bg-card p-3 space-y-2">
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search users…" aria-label="Search users" autoFocus />
          <div className="max-h-48 overflow-y-auto space-y-1">
            {candidates.map(u => (
              <div key={u.id} className="flex items-center gap-2 px-2 py-1.5 rounded-sm hover:bg-bg-raised transition-colors">
                <Users size={12} className="text-text-muted shrink-0" aria-hidden />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-text-primary">{u.name ?? u.username}</p>
                  <p className="text-[10px] text-text-muted">{u.username}</p>
                </div>
                {TIERS.map(tier => (
                  <button key={tier} onClick={() => { setTier(u.id, tier); setShowAdd(false) }}
                    aria-label={`Assign ${u.username} as ${tier}`}
                    className={`px-2 py-0.5 rounded-sm text-[10px] font-medium border transition-colors ${TIER_BUTTON[tier]}`}>
                    {tier}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <button onClick={() => setShowAdd(false)} className="text-xs text-text-muted hover:text-text-primary transition-colors">Cancel</button>
        </div>
      )}

      {!tiers ? (
        <LoadingBlock />
      ) : tiers.length === 0 ? (
        <EmptyCard>No explicit user tiers set. All users default to viewer.</EmptyCard>
      ) : (
        <ul className="rounded-lg border border-border-subtle bg-bg-card divide-y divide-border-subtle overflow-hidden">
          {tiers.map(ut => (
            <li key={ut.userId} className="flex items-center gap-3 px-4 py-2.5">
              <Users size={13} className="text-text-muted shrink-0" aria-hidden />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text-primary">{ut.user.name ?? ut.user.username}</p>
                <p className="text-xs text-text-muted">{ut.user.username} · ORION role: {ut.user.role}</p>
              </div>
              <Select value={ut.tier} onChange={e => setTier(ut.userId, e.target.value)} disabled={busy}
                aria-label={`Tier for ${ut.user.username}`} className="w-auto px-2 py-1 text-xs">
                {TIERS.map(t => <option key={t} value={t}>{t}</option>)}
              </Select>
              <IconButton label={`Remove ${ut.user.username}'s tier`} onClick={() => removeTier(ut.userId)} className="hover:text-status-error">
                <X size={12} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
