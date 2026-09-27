'use client'

import { useState } from 'react'
import { Trash2, Check, X, RefreshCw } from 'lucide-react'
import { MIDDLEWARE_TYPES } from './middlewareTypes'
import type { IngressMiddleware } from '../types'

export function MiddlewareRow({ mw, onToggle, onDelete }: {
  mw: IngressMiddleware
  onToggle: () => Promise<void>
  onDelete: () => Promise<void>
}) {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy]       = useState(false)
  const typeInfo = MIDDLEWARE_TYPES.find(t => t.value === mw.type) ?? MIDDLEWARE_TYPES[MIDDLEWARE_TYPES.length - 1]
  const Icon = typeInfo.icon

  const doToggle = async () => { setBusy(true); await onToggle(); setBusy(false) }
  const doDelete = async () => { setBusy(true); await onDelete(); setBusy(false) }

  return (
    <div className={`flex items-center gap-3 px-3 py-2 rounded-lg border text-xs transition-colors ${
      mw.enabled ? 'border-border-subtle bg-bg-surface' : 'border-border-subtle/50 bg-bg-canvas opacity-60'
    }`}>
      <Icon size={13} className={mw.enabled ? 'text-accent flex-shrink-0' : 'text-text-muted flex-shrink-0'} />
      <div className="flex-1 min-w-0">
        <span className="font-mono font-medium text-text-primary">{mw.name}</span>
        <span className="ml-2 text-[10px] text-text-muted">{typeInfo.label}</span>
      </div>
      <button
        onClick={doToggle}
        disabled={busy}
        className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
          mw.enabled
            ? 'border-status-healthy/40 text-status-healthy hover:bg-status-healthy/10'
            : 'border-border-subtle text-text-muted hover:border-accent/40'
        }`}
      >
        {mw.enabled ? 'active' : 'off'}
      </button>
      {confirm ? (
        <span className="flex items-center gap-1">
          <button aria-label="Confirm delete" onClick={doDelete} disabled={busy} className="text-status-error hover:opacity-70">
            {busy ? <RefreshCw size={10} className="animate-spin" /> : <Check size={10} />}
          </button>
          <button aria-label="Cancel delete" onClick={() => setConfirm(false)} className="text-text-muted hover:text-text-primary"><X size={10} /></button>
        </span>
      ) : (
        <button aria-label={`Delete middleware ${mw.name}`} onClick={() => setConfirm(true)} className="text-text-muted hover:text-status-error transition-colors">
          <Trash2 size={10} />
        </button>
      )}
    </div>
  )
}

// ── New Middleware form ────────────────────────────────────────────────────────
