'use client'

import { useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import { inputCls, btnPrimary, btnGhost } from '../styles'
import type { IngressPoint, Env } from '../types'

export function NewPointForm({
  domainId, environments, onCreated,
}: {
  domainId: string; environments: Env[]; onCreated: (p: IngressPoint) => void
}) {
  const [open, setOpen]   = useState(false)
  const [form, setForm]   = useState({
    name: '', type: 'traefik', ip: '', port: '443',
    environmentId: '', certManager: true, clusterIssuer: 'letsencrypt-prod',
  })
  const [saving, setSaving] = useState(false)

  const set = (k: string, v: string | boolean) => setForm(f => ({ ...f, [k]: v }))

  const submit = async () => {
    if (!form.name.trim()) return
    setSaving(true)
    const res = await fetch(`/api/ingress/domains/${domainId}/points`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        port: Number(form.port) || 443,
        environmentId: form.environmentId || null,
      }),
    })
    const p = await res.json()
    onCreated(p)
    setForm({ name: '', type: 'traefik', ip: '', port: '443', environmentId: '', certManager: true, clusterIssuer: 'letsencrypt-prod' })
    setOpen(false); setSaving(false)
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className={`${btnGhost} text-[11px]`}>
        <Plus size={10} /> Add ingress point
      </button>
    )
  }
  return (
    <div className="mt-2 p-3 rounded-lg border border-border-subtle bg-bg-raised space-y-2 text-xs">
      <div className="grid grid-cols-2 gap-2">
        <input value={form.name} onChange={e => set('name', e.target.value)} placeholder="Name (e.g. Traefik)" className={inputCls} />
        <select value={form.type} onChange={e => set('type', e.target.value)} className={inputCls}>
          {['traefik','nginx','cilium','haproxy','cloudflare-tunnel','other'].map(t => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input value={form.ip} onChange={e => set('ip', e.target.value)} placeholder="VIP / IP (e.g. 10.2.2.200)" className={inputCls} />
        <input value={form.port} onChange={e => set('port', e.target.value)} placeholder="Port (443)" className={inputCls} />
      </div>
      <select value={form.environmentId} onChange={e => set('environmentId', e.target.value)} className={inputCls}>
        <option value="">No environment linked</option>
        {environments.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
      </select>
      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" checked={form.certManager} onChange={e => set('certManager', e.target.checked)} className="rounded" />
        <span className="text-text-secondary">Use cert-manager (Let&apos;s Encrypt)</span>
      </label>
      {form.certManager && (
        <input value={form.clusterIssuer} onChange={e => set('clusterIssuer', e.target.value)} placeholder="ClusterIssuer name" className={inputCls} />
      )}
      <div className="flex gap-2">
        <button onClick={submit} disabled={saving || !form.name.trim()} className={btnPrimary}>
          {saving ? <RefreshCw size={11} className="animate-spin" /> : <Plus size={11} />} Add
        </button>
        <button onClick={() => setOpen(false)} className={btnGhost}>Cancel</button>
      </div>
    </div>
  )
}

// ── New Route form ────────────────────────────────────────────────────────────
