'use client'

import { useState } from 'react'
import { Pencil, Check, X, RefreshCw } from 'lucide-react'

export function StatusDot({ status }: { status: string }) {
  const color =
    status === 'bootstrapped' ? 'bg-status-healthy' :
    status === 'active'       ? 'bg-status-healthy' :
    status === 'error'        ? 'bg-status-error'   :
    'bg-text-muted'
  return <span className={`w-2 h-2 rounded-full flex-shrink-0 ${color}`} />
}

// ── Inline editable text ──────────────────────────────────────────────────────

export function InlineEdit({
  value, placeholder, onSave, className = '',
}: {
  value: string | null; placeholder: string; onSave: (v: string) => Promise<void>; className?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft]     = useState(value ?? '')
  const [saving, setSaving]   = useState(false)

  const save = async () => {
    setSaving(true)
    await onSave(draft)
    setSaving(false)
    setEditing(false)
  }

  if (editing) {
    return (
      <span className="flex items-center gap-1">
        <input
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
          className="px-1.5 py-0.5 text-xs bg-bg-raised border border-accent rounded text-text-primary focus:outline-none w-48"
        />
        <button aria-label="Save" onClick={save} disabled={saving} className="text-status-healthy hover:opacity-80">
          {saving ? <RefreshCw size={11} className="animate-spin" /> : <Check size={11} />}
        </button>
        <button aria-label="Cancel" onClick={() => setEditing(false)} className="text-text-muted hover:text-text-primary"><X size={11} /></button>
      </span>
    )
  }
  return (
    <button
      onClick={() => { setDraft(value ?? ''); setEditing(true) }}
      className={`group flex items-center gap-1 text-left ${className}`}
      title="Click to edit"
    >
      <span className={value ? '' : 'italic text-text-muted/60'}>{value || placeholder}</span>
      <Pencil size={10} className="opacity-0 group-hover:opacity-60 text-text-muted flex-shrink-0" />
    </button>
  )
}

// ── Bootstrap panel ───────────────────────────────────────────────────────────
