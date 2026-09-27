'use client'
import { useState } from 'react'
import useSWR from 'swr'
import { Bot, User as UserIcon, X, Loader2, Plus } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { Button, IconButton } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { apiFetch, errorMessage } from '@/lib/api'
import type { InviteOption } from './types'

// ── Invite ───────────────────────────────────────────────────────────────────

interface InviteProps {
  roomId: string
  onClose: () => void
  onInvited: () => void
}

export function InviteMemberDialog({ roomId, onClose, onInvited }: InviteProps) {
  const { data, isLoading } = useSWR<{ users?: InviteOption[]; agents?: InviteOption[] }>(`/api/chatrooms/${roomId}/members`)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'agents' | 'users'>('agents')
  const [inviting, setInviting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const users = data?.users ?? []
  const agents = data?.agents ?? []
  const q = search.toLowerCase()
  const list = (tab === 'agents' ? agents : users).filter(o =>
    !search || (o.name || o.username || '').toLowerCase().includes(q)
  )

  const invite = async (option: InviteOption) => {
    if (inviting) return
    setError(null)
    setInviting(option.id)
    try {
      await apiFetch(`/api/chatrooms/${roomId}/invite`, {
        method: 'POST',
        body: tab === 'agents' ? { agentId: option.id } : { userId: option.id },
      })
      onInvited()
    } catch (e) {
      setError(errorMessage(e, 'Unknown error'))
      setInviting(null)
    }
  }

  const tabButton = (id: 'agents' | 'users', label: string) => (
    <button
      role="tab"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
      className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${tab === id ? 'text-accent border-b-2 border-accent' : 'text-text-muted hover:text-text-primary'}`}
    >
      {label}
    </button>
  )

  return (
    <Dialog
      onClose={onClose}
      label="Add member"
      className="w-full max-w-md bg-bg-sidebar border border-border-subtle rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-60 md:max-h-96"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle shrink-0">
        <span className="text-sm font-semibold text-text-primary">Add Member</span>
        <IconButton label="Close" onClick={onClose}><X size={16} /></IconButton>
      </div>

      {error && (
        <div role="alert" className="px-4 py-2 border-b border-status-error/30 bg-status-error/10 flex items-center gap-2 shrink-0">
          <span className="text-xs text-status-error flex-1">{error}</span>
          <IconButton label="Dismiss error" onClick={() => setError(null)} className="p-0 text-status-error hover:text-status-error/60"><X size={14} /></IconButton>
        </div>
      )}

      <div className="px-3 py-2 border-b border-border-subtle shrink-0">
        <Input
          aria-label="Search members"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search..."
          className="py-1.5 text-xs border-border-visible placeholder-text-muted"
        />
      </div>

      <div role="tablist" aria-label="Member type" className="flex border-b border-border-subtle shrink-0">
        {tabButton('agents', `Agents (${agents.length})`)}
        {tabButton('users', `Users (${users.length})`)}
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-8"><Loader2 size={16} className="animate-spin text-text-muted" /></div>
        ) : list.length === 0 ? (
          <div className="text-center text-text-muted text-xs py-8">
            {search ? 'No results' : 'No available options'}
          </div>
        ) : (
          list.map(option => (
            <button
              key={option.id}
              onClick={() => void invite(option)}
              disabled={inviting === option.id}
              className="w-full flex items-center gap-2 px-4 py-2 text-xs text-left text-text-secondary hover:bg-bg-raised hover:text-text-primary transition-colors disabled:opacity-50"
            >
              {tab === 'agents'
                ? <Bot size={13} className="text-accent shrink-0" />
                : <UserIcon size={13} className="text-text-muted shrink-0" />}
              <span className="flex-1 truncate">
                {option.name}{option.username ? ` (${option.username})` : ''}
              </span>
              {inviting === option.id
                ? <Loader2 size={12} className="animate-spin text-text-muted" />
                : <Plus size={12} className="text-text-muted" />}
            </button>
          ))
        )}
      </div>
    </Dialog>
  )
}

// ── Leave ────────────────────────────────────────────────────────────────────

export function LeaveRoomDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <Dialog
      onClose={onCancel}
      labelledBy="leave-room-title"
      className="w-full max-w-sm bg-bg-sidebar border border-border-subtle rounded-xl shadow-2xl overflow-hidden"
    >
      <div className="p-4">
        <h3 id="leave-room-title" className="text-sm font-semibold text-text-primary mb-2">Leave Room</h3>
        <p className="text-xs text-text-muted mb-4">You will leave this chat room. You can rejoin later if invited.</p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} className="text-text-muted hover:text-text-primary hover:border-border-subtle">
            Cancel
          </Button>
          <Button onClick={onConfirm} className="bg-status-error hover:bg-status-error/80 font-normal">
            Leave
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
