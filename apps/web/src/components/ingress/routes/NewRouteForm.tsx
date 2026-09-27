'use client'

import { useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import { inputCls, btnPrimary, btnGhost } from '../styles'
import type { IngressMiddleware, IngressRoute } from '../types'

export function NewRouteForm({
  pointId, domainName, availableMiddlewares, onCreated,
}: {
  pointId: string; domainName: string; availableMiddlewares: IngressMiddleware[]; onCreated: (r: IngressRoute) => void
}) {
  const [open, setOpen]             = useState(false)
  const [host, setHost]             = useState('')
  const [service, setService]       = useState('')
  const [port, setPort]             = useState('80')
  const [namespace, setNamespace]   = useState('default')
  const [tls, setTls]               = useState(true)
  const [comment, setComment]       = useState('')
  const [selMws, setSelMws]         = useState<string[]>([])
  const [saving, setSaving]         = useState(false)

  const toggleMw = (name: string) =>
    setSelMws(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name])

  const submit = async () => {
    if (!host.trim()) return
    setSaving(true)
    const res = await fetch(`/api/ingress/points/${pointId}/routes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: host.includes('.') ? host : `${host}.${domainName}`,
        tls,
        comment: comment || null,
        middlewares: selMws,
        paths: service ? [{ path: '/', service, port: Number(port) || 80, namespace }] : [],
      }),
    })
    const r = await res.json()
    onCreated(r)
    setHost(''); setService(''); setPort('80'); setNamespace('default'); setComment(''); setSelMws([]); setOpen(false); setSaving(false)
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className={`${btnGhost} text-[11px]`}>
        <Plus size={10} /> Add route
      </button>
    )
  }
  return (
    <div className="mt-2 p-3 rounded-lg border border-border-subtle bg-bg-raised space-y-2 text-xs">
      <input
        autoFocus
        value={host}
        onChange={e => setHost(e.target.value)}
        placeholder={`subdomain or full host (e.g. auth.${domainName})`}
        className={inputCls}
      />
      <div className="grid grid-cols-3 gap-2">
        <input value={service} onChange={e => setService(e.target.value)} placeholder="Service name" className={inputCls} />
        <input value={port} onChange={e => setPort(e.target.value)} placeholder="Port" className={inputCls} />
        <input value={namespace} onChange={e => setNamespace(e.target.value)} placeholder="Namespace" className={inputCls} />
      </div>
      <input value={comment} onChange={e => setComment(e.target.value)} placeholder="Comment (optional)" className={inputCls} />
      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" checked={tls} onChange={e => setTls(e.target.checked)} className="rounded" />
        <span className="text-text-secondary">TLS / HTTPS</span>
      </label>
      {availableMiddlewares.length > 0 && (
        <div className="space-y-1">
          <p className="text-text-muted text-[10px] uppercase tracking-wide">Middlewares</p>
          <div className="flex flex-wrap gap-1.5">
            {availableMiddlewares.map(mw => (
              <label key={mw.id} className={`flex items-center gap-1 px-2 py-0.5 rounded border cursor-pointer transition-colors text-[11px] ${
                selMws.includes(mw.name)
                  ? 'border-accent/60 bg-accent/10 text-accent'
                  : 'border-border-subtle text-text-muted hover:border-accent/30'
              }`}>
                <input
                  type="checkbox"
                  className="hidden"
                  checked={selMws.includes(mw.name)}
                  onChange={() => toggleMw(mw.name)}
                />
                {mw.name}
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="flex gap-2">
        <button onClick={submit} disabled={saving || !host.trim()} className={btnPrimary}>
          {saving ? <RefreshCw size={11} className="animate-spin" /> : <Plus size={11} />} Add route
        </button>
        <button onClick={() => setOpen(false)} className={btnGhost}>Cancel</button>
      </div>
    </div>
  )
}

// ── Route row ─────────────────────────────────────────────────────────────────
