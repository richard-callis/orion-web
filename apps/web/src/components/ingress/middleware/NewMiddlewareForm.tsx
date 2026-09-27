'use client'

import { useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import { MIDDLEWARE_TYPES } from './middlewareTypes'
import { inputCls, btnPrimary, btnGhost } from '../styles'
import type { IngressMiddleware } from '../types'

export function NewMiddlewareForm({ pointId, onCreated }: { pointId: string; onCreated: (m: IngressMiddleware) => void }) {
  const [open, setOpen]     = useState(false)
  const [name, setName]     = useState('')
  const [type, setType]     = useState('crowdsec')
  const [namespace, setNs]  = useState('security')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!name.trim()) return
    setSaving(true)
    const res = await fetch(`/api/ingress/points/${pointId}/middlewares`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), type, config: { namespace } }),
    })
    const m = await res.json()
    onCreated(m)
    setName(''); setType('crowdsec'); setNs('security'); setOpen(false); setSaving(false)
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className={`${btnGhost} text-[11px] w-full justify-center mt-1`}>
        <Plus size={10} /> Add middleware
      </button>
    )
  }

  return (
    <div className="mt-2 p-3 rounded-lg border border-border-subtle bg-bg-raised space-y-2 text-xs">
      <div className="grid grid-cols-2 gap-2">
        <input
          autoFocus
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
          placeholder="e.g. crowdsec-bouncer"
          className={inputCls}
        />
        <select value={type} onChange={e => setType(e.target.value)} className={inputCls}>
          {MIDDLEWARE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>
      <input
        value={namespace}
        onChange={e => setNs(e.target.value)}
        placeholder="Namespace (e.g. security)"
        className={inputCls}
      />
      <div className="flex gap-2">
        <button onClick={submit} disabled={saving || !name.trim()} className={btnPrimary}>
          {saving ? <RefreshCw size={11} className="animate-spin" /> : <Plus size={11} />} Add
        </button>
        <button onClick={() => setOpen(false)} className={btnGhost}>Cancel</button>
      </div>
    </div>
  )
}

// ── SSO Provider bootstrap ───────────────────────────────────────────────────
