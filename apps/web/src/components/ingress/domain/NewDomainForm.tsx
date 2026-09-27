'use client'

import { useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import { inputCls, btnPrimary, btnGhost } from '../styles'
import type { Domain } from '../types'

export function NewDomainForm({ onCreated }: { onCreated: (d: Domain) => void }) {
  const [open, setOpen]     = useState(false)
  const [name, setName]     = useState('')
  const [type, setType]     = useState('public')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!name.trim()) return
    setSaving(true)
    const res = await fetch('/api/ingress/domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type }),
    })
    const d = await res.json()
    onCreated(d)
    setName(''); setType('public'); setOpen(false); setSaving(false)
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className={`${btnGhost} w-full justify-center mt-2`}>
        <Plus size={12} /> Add domain
      </button>
    )
  }
  return (
    <div className="mt-2 p-3 rounded-lg border border-border-subtle bg-bg-raised space-y-2">
      <input
        autoFocus
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && submit()}
        placeholder="khalisio.com"
        className={inputCls}
      />
      <select value={type} onChange={e => setType(e.target.value)} className={inputCls}>
        <option value="public">Public</option>
        <option value="internal">Internal (LAN only)</option>
      </select>
      <div className="flex gap-2">
        <button onClick={submit} disabled={saving || !name.trim()} className={btnPrimary}>
          {saving ? <RefreshCw size={11} className="animate-spin" /> : <Plus size={11} />}
          Create
        </button>
        <button onClick={() => setOpen(false)} className={btnGhost}>Cancel</button>
      </div>
    </div>
  )
}

// ── New Ingress Point form ────────────────────────────────────────────────────
