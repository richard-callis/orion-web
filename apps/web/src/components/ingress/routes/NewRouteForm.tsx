'use client'

import { useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import type { IngressMiddleware, IngressRoute } from '../types'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { apiFetch, errorMessage } from '@/lib/api'
import { useToast } from '@/components/ui/Toast'

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
  const toast = useToast()

  const toggleMw = (name: string) =>
    setSelMws(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name])

  const submit = async () => {
    if (!host.trim()) return
    setSaving(true)
    try {
      const r = await apiFetch<IngressRoute>(`/api/ingress/points/${pointId}/routes`, {
        method: 'POST',
        body: {
          host: host.includes('.') ? host : `${host}.${domainName}`,
          tls,
          comment: comment || null,
          middlewares: selMws,
          paths: service ? [{ path: '/', service, port: Number(port) || 80, namespace }] : [],
        },
      })
      onCreated(r)
      setHost(''); setService(''); setPort('80'); setNamespace('default'); setComment(''); setSelMws([]); setOpen(false)
    } catch (e) {
      toast.error(`Failed to create route: ${errorMessage(e)}`)
    } finally {
      setSaving(false)
    }
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} variant="secondary" className="text-[11px]">
        <Plus size={10} /> Add route
      </Button>
    )
  }
  return (
    <div className="mt-2 p-3 rounded-lg border border-border-subtle bg-bg-raised space-y-2 text-xs">
      <Input
        autoFocus
        value={host}
        onChange={e => setHost(e.target.value)}
        placeholder={`subdomain or full host (e.g. auth.${domainName})`}
      />
      <div className="grid grid-cols-3 gap-2">
        <Input value={service} onChange={e => setService(e.target.value)} placeholder="Service name" />
        <Input value={port} onChange={e => setPort(e.target.value)} placeholder="Port" />
        <Input value={namespace} onChange={e => setNamespace(e.target.value)} placeholder="Namespace" />
      </div>
      <Input value={comment} onChange={e => setComment(e.target.value)} placeholder="Comment (optional)" />
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
        <Button onClick={submit} disabled={saving || !host.trim()}>
          {saving ? <RefreshCw size={11} className="animate-spin" /> : <Plus size={11} />} Add route
        </Button>
        <Button onClick={() => setOpen(false)} variant="secondary">Cancel</Button>
      </div>
    </div>
  )
}

// ── Route row ─────────────────────────────────────────────────────────────────
