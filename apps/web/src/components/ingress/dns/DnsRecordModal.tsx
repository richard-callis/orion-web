'use client'

import { useState } from 'react'
import { Check, X, RefreshCw } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { inputCls, btnPrimary, btnGhost } from '../styles'
import type { DnsRecord, Domain } from '../types'

export function DnsRecordModal({ domain, initial, suggestedIp, onSave, onClose }: {
  domain: Domain
  initial?: DnsRecord
  suggestedIp: string | null
  onSave: () => void
  onClose: () => void
}) {
  const editing = !!initial
  const [ip, setIp]               = useState(initial?.ip ?? suggestedIp ?? '')
  const [hostnames, setHostnames] = useState(initial?.hostnames.join(', ') ?? '')
  const [comment, setComment]     = useState(initial?.comment ?? '')
  const [saving, setSaving]       = useState(false)
  const [err, setErr]             = useState('')

  const save = async () => {
    const hosts = hostnames.split(/[\s,]+/).map(h => h.trim()).filter(Boolean)
    if (!ip.trim() || !hosts.length) { setErr('IP and at least one hostname are required.'); return }
    setSaving(true); setErr('')
    try {
      const url = editing
        ? `/api/ingress/domains/${domain.id}/dns/records/${initial!.id}`
        : `/api/ingress/domains/${domain.id}/dns/records`
      const r = await fetch(url, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: ip.trim(), hostnames: hosts, comment: comment || null }),
      })
      if (!r.ok) throw new Error((await r.json()).error ?? 'Failed to save')
      onSave(); onClose()
    } catch (e) { setErr(String(e)) }
    finally { setSaving(false) }
  }

  return (
    <Dialog
      onClose={onClose}
      label={editing ? 'Edit DNS record' : 'Add DNS record'}
      className="w-full max-w-md bg-[#1e1e2e] border border-border-subtle rounded-xl shadow-2xl"
    >
      <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
        <h2 className="text-sm font-semibold text-text-primary">{editing ? 'Edit DNS Record' : 'Add DNS Record'}</h2>
        <button onClick={onClose} className="text-text-muted hover:text-text-primary"><X size={15} /></button>
      </div>
      <div className="px-5 py-4 space-y-4">
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">IP Address</label>
          <input value={ip} onChange={e => setIp(e.target.value)} placeholder="e.g. 10.2.2.30" autoFocus className={inputCls} />
        </div>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">Hostnames</label>
          <input
            value={hostnames}
            onChange={e => setHostnames(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && save()}
            placeholder={`*.${domain.name}, app.${domain.name}`}
            className={inputCls}
          />
          <p className="text-[11px] text-text-muted mt-1">Comma or space separated. Use <code className="font-mono">*.{domain.name}</code> for wildcard.</p>
        </div>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">Comment <span className="text-text-muted font-normal">(optional)</span></label>
          <input value={comment} onChange={e => setComment(e.target.value)} placeholder="e.g. Wildcard for all internal services" className={inputCls} />
        </div>
        {err && <p className="text-xs text-status-error">{err}</p>}
      </div>
      <div className="flex justify-end gap-2 px-5 py-3 border-t border-border-subtle">
        <button onClick={onClose} className={btnGhost}>Cancel</button>
        <button onClick={save} disabled={saving} className={btnPrimary}>
          {saving ? <RefreshCw size={12} className="animate-spin" /> : <Check size={12} />}
          {editing ? 'Save changes' : 'Add record'}
        </button>
      </div>
    </Dialog>
  )
}
