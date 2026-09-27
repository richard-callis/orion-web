'use client'
import { useState } from 'react'
import { Bot, User as UserIcon, Hash, X, Plus, LogOut, BookmarkCheck, UserMinus } from 'lucide-react'
import ContextWindowBar from '@/components/messages/ContextWindowBar'
import { IconButton } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import type { RoomDetail, RoomGoal, RoomMember } from './types'

const TYPE_COLORS: Record<string, string> = {
  task: 'bg-blue-500/20 text-blue-400',
  feature: 'bg-purple-500/20 text-purple-400',
  general: 'bg-gray-500/20 text-gray-400',
  ops: 'bg-orange-500/20 text-orange-400',
}

const inlineInputClass = 'flex-1 w-auto text-xs bg-bg-sidebar px-2.5 py-1.5 placeholder-text-muted'

// ── Header ────────────────────────────────────────────────────────────────────

interface HeaderProps {
  room: RoomDetail | null
  tokenState: { count: number; limit: number | null }
  compacting: boolean
  onCompact: () => void
  onMobileBack: () => void
  onInvite: () => void
  onToggleGoal: () => void
  onLeave: () => void
}

export function RoomHeader({ room, tokenState, compacting, onCompact, onMobileBack, onInvite, onToggleGoal, onLeave }: HeaderProps) {
  return (
    <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle flex-shrink-0">
      <IconButton label="Back to room list" onClick={onMobileBack} className="md:hidden hover:bg-bg-raised">
        <Hash size={16} className="text-text-muted" />
      </IconButton>
      <Hash size={14} className="text-text-muted flex-shrink-0" aria-hidden />
      <span className="text-sm font-semibold text-text-primary truncate">{room?.name}</span>
      {room && <span className={`px-1.5 py-0.5 rounded text-[9px] flex-shrink-0 ${TYPE_COLORS[room.type] || TYPE_COLORS.general}`}>{room.type}</span>}
      <ContextWindowBar
        tokenCount={tokenState.count}
        tokenLimit={tokenState.limit}
        onCompact={onCompact}
        compacting={compacting}
      />
      <div className="flex items-center gap-1 ml-auto flex-shrink-0">
        <IconButton label="Add member" onClick={onInvite} className="p-1.5 hover:bg-bg-raised hover:text-accent">
          <Plus size={14} />
        </IconButton>
        <IconButton
          label={room?.activeGoal ? `Active goal: ${room.activeGoal.text}` : 'Set goal'}
          onClick={onToggleGoal}
          className={`p-1.5 hover:bg-bg-raised ${room?.activeGoal ? 'text-accent' : 'hover:text-accent'}`}
        >
          <BookmarkCheck size={14} />
        </IconButton>
        <IconButton label="Leave room" onClick={onLeave} className="p-1.5 hover:bg-bg-raised hover:text-status-error">
          <LogOut size={14} />
        </IconButton>
      </div>
    </div>
  )
}

// ── Inline text + submit row (set goal / complete goal) ─────────────────────

interface InlineRowProps {
  label: string
  placeholder: string
  submitLabel: string
  busyLabel: string
  busy: boolean
  requireText: boolean
  tone: 'accent' | 'healthy'
  className: string
  onSubmit: (text: string) => void
  onCancel: () => void
}

export function InlineInputRow({ label, placeholder, submitLabel, busyLabel, busy, requireText, tone, className, onSubmit, onCancel }: InlineRowProps) {
  const [text, setText] = useState('')
  const submit = () => { if (!busy && (!requireText || text.trim())) onSubmit(text.trim()) }
  const toneClass = tone === 'accent'
    ? 'bg-accent/20 text-accent hover:bg-accent/30'
    : 'bg-status-healthy/20 text-status-healthy hover:bg-status-healthy/30'
  return (
    <div className={`flex items-center gap-2 px-4 py-2 ${className}`}>
      <Input
        autoFocus
        aria-label={label}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel() }}
        placeholder={placeholder}
        className={inlineInputClass}
      />
      <button
        onClick={submit}
        disabled={busy || (requireText && !text.trim())}
        className={`text-xs px-3 py-1.5 rounded disabled:opacity-40 transition-colors ${toneClass}`}
      >
        {busy ? busyLabel : submitLabel}
      </button>
      <IconButton label="Cancel" onClick={onCancel}><X size={13} /></IconButton>
    </div>
  )
}

// ── Members ──────────────────────────────────────────────────────────────────

export function MembersBar({ members, onKick }: { members: RoomMember[]; onKick: (m: RoomMember) => void }) {
  if (members.length === 0) return null
  return (
    <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border-subtle flex-shrink-0 overflow-x-auto">
      <span className="text-[10px] text-text-muted flex-shrink-0">Members:</span>
      {members.map((m, i) => (
        <span key={m.agentId ?? m.userId ?? i} className="group/member flex items-center gap-1 text-[10px] text-text-secondary bg-bg-raised px-2 py-0.5 rounded-full flex-shrink-0">
          {m.agent ? <Bot size={11} className="text-accent" /> : <UserIcon size={11} />}
          {m.agent?.name || m.user?.name || m.user?.username || 'unknown'}
          {m.role === 'lead' && <span className="text-accent">·</span>}
          {m.agentId && (
            <IconButton
              label={`Remove ${m.agent?.name ?? 'agent'} from room`}
              onClick={() => onKick(m)}
              className="p-0 ml-0.5 opacity-0 group-hover/member:opacity-100 focus-visible:opacity-100 hover:text-status-error"
            >
              <UserMinus size={10} />
            </IconButton>
          )}
        </span>
      ))}
    </div>
  )
}

// ── Goal banner ──────────────────────────────────────────────────────────────

interface GoalBannerProps {
  goal: RoomGoal
  completing: boolean
  onComplete: (summary: string) => void
  onAbandon: () => void
}

export function GoalBanner({ goal, completing, onComplete, onAbandon }: GoalBannerProps) {
  const [showComplete, setShowComplete] = useState(false)
  return (
    <div className="flex-shrink-0 border-b border-border-subtle">
      <div className="flex items-center justify-between px-4 py-2 bg-accent/5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-accent flex-shrink-0" aria-hidden>🎯</span>
          <span className="text-xs text-text-primary truncate">{goal.text}</span>
          <span className="text-xs text-text-muted flex-shrink-0">
            · {Math.round((Date.now() - new Date(goal.createdAt).getTime()) / 60000)}m ago
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
          <button
            onClick={() => setShowComplete(v => !v)}
            aria-expanded={showComplete}
            className="text-[11px] px-2 py-0.5 rounded bg-status-healthy/15 text-status-healthy hover:bg-status-healthy/25 transition-colors"
          >
            Complete ✓
          </button>
          <button
            onClick={onAbandon}
            className="text-[11px] px-2 py-0.5 rounded bg-status-error/10 text-status-error hover:bg-status-error/20 transition-colors"
          >
            Abandon ×
          </button>
        </div>
      </div>
      {showComplete && (
        <InlineInputRow
          label="Completion summary"
          placeholder="Optional: describe what was accomplished…"
          submitLabel="Confirm"
          busyLabel="Saving…"
          busy={completing}
          requireText={false}
          tone="healthy"
          className="bg-bg-raised border-t border-border-subtle"
          onSubmit={summary => { onComplete(summary); setShowComplete(false) }}
          onCancel={() => setShowComplete(false)}
        />
      )}
    </div>
  )
}

// ── Typing indicator ─────────────────────────────────────────────────────────

export function TypingIndicator({ names }: { names: string[] }) {
  if (names.length === 0) return null
  return (
    <div className="px-4 py-1 flex items-center gap-1.5 flex-shrink-0" aria-live="polite">
      <span className="flex gap-0.5 items-end" aria-hidden>
        <span className="w-1 h-1 rounded-full bg-accent animate-bounce0" />
        <span className="w-1 h-1 rounded-full bg-accent animate-bounce150" />
        <span className="w-1 h-1 rounded-full bg-accent animate-bounce300" />
      </span>
      <span className="text-[10px] text-text-muted italic">
        {names.length === 1
          ? `${names[0]} is typing…`
          : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are typing…`}
      </span>
    </div>
  )
}
