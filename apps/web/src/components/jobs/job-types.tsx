'use client'
import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { IconButton } from '@/components/ui/Button'

export type Tab = 'schedules' | 'webhooks' | 'system' | 'history'

type AgentRef = { id: string; name: string }

export interface ScheduledTask {
  id: string
  name: string
  description?: string | null
  agentId: string
  agent: AgentRef
  cronExpr: string
  taskTitle: string
  taskDesc?: string | null
  enabled: boolean
  lastRunAt?: string | null
  nextRunAt?: string | null
  lastTaskId?: string | null
  createdAt: string
  updatedAt: string
}

export interface WebhookTrigger {
  id: string
  name: string
  source: string
  agentId: string
  agent: AgentRef
  taskTitle: string
  taskDesc: string | null
  enabled: boolean
  lastFiredAt: string | null
  fireCount: number
  createdAt: string
  secret?: string
}

export interface JobRun {
  id: string
  source: string
  sourceId: string
  sourceName: string
  agentId: string | null
  taskId: string | null
  status: string
  startedAt: string
  finishedAt: string | null
  errorMessage: string | null
}

export function formatDate(d: string | null | undefined) {
  if (!d) return '—'
  try { return new Date(d).toLocaleString() } catch { return d }
}

export function duration(start: string, end: string | null) {
  if (!end) return 'running…'
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60000)}m`
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <IconButton
      label={copied ? 'Copied' : label}
      onClick={async () => { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
      className="hover:bg-bg-raised"
    >
      {copied ? <Check size={14} className="text-status-healthy" /> : <Copy size={14} />}
    </IconButton>
  )
}

/** Two-step inline delete/regenerate confirmation. */
export function ConfirmInline({ label, onConfirm, onCancel }: { label: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="flex items-center gap-1 justify-end">
      <button onClick={onConfirm} className="px-2 py-1 text-xs text-white bg-red-500 rounded-sm hover:bg-red-600 transition-colors">{label}</button>
      <button onClick={onCancel} className="px-2 py-1 text-xs text-text-secondary border border-border-subtle rounded-sm hover:bg-bg-raised transition-colors">Cancel</button>
    </div>
  )
}

export const thCls = 'px-4 py-2.5 text-left text-xs font-medium text-text-secondary'
