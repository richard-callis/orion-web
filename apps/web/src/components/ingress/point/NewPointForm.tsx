'use client'

import { useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import type { IngressPoint, Env } from '../types'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { apiFetch, errorMessage } from '@/lib/api'
import { useToast } from '@/components/ui/Toast'

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
  const toast = useToast()

  const set = (k: string, v: string | boolean) => setForm(f => ({ ...f, [k]: v }))

  const submit = async () => {
    if (!form.name.trim()) return
    setSaving(true)
    try {
      const p = await apiFetch<IngressPoint>(`/api/ingress/domains/${domainId}/points`, {
        method: 'POST',
        body: {
          ...form,
          port: Number(form.port) || 443,
          environmentId: form.environmentId || null,
        },
      })
      onCreated(p)
      setForm({ name: '', type: 'traefik', ip: '', port: '443', environmentId: '', certManager: true, clusterIssuer: 'letsencrypt-prod' })
      setOpen(false)
    } catch (e) {
      toast.error(`Failed to create ingress point: ${errorMessage(e)}`)
    } finally {
      setSaving(false)
    }
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} variant="secondary" className="text-[11px]">
        <Plus size={10} /> Add ingress point
      </Button>
    )
  }
  return (
    <div className="mt-2 p-3 rounded-lg border border-border-subtle bg-bg-raised space-y-2 text-xs">
      <div className="grid grid-cols-2 gap-2">
        <Input value={form.name} onChange={e => set('name', e.target.value)} placeholder="Name (e.g. Traefik)" />
        <Select value={form.type} onChange={e => set('type', e.target.value)}>
          {['traefik','nginx','cilium','haproxy','cloudflare-tunnel','other'].map(t => (
            <option key={t} value={t}>{t}</option>
          ))}
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Input value={form.ip} onChange={e => set('ip', e.target.value)} placeholder="VIP / IP (e.g. 10.2.2.200)" />
        <Input value={form.port} onChange={e => set('port', e.target.value)} placeholder="Port (443)" />
      </div>
      <Select value={form.environmentId} onChange={e => set('environmentId', e.target.value)}>
        <option value="">No environment linked</option>
        {environments.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
      </Select>
      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" checked={form.certManager} onChange={e => set('certManager', e.target.checked)} className="rounded" />
        <span className="text-text-secondary">Use cert-manager (Let&apos;s Encrypt)</span>
      </label>
      {form.certManager && (
        <Input value={form.clusterIssuer} onChange={e => set('clusterIssuer', e.target.value)} placeholder="ClusterIssuer name" />
      )}
      <div className="flex gap-2">
        <Button onClick={submit} disabled={saving || !form.name.trim()}>
          {saving ? <RefreshCw size={11} className="animate-spin" /> : <Plus size={11} />} Add
        </Button>
        <Button onClick={() => setOpen(false)} variant="secondary">Cancel</Button>
      </div>
    </div>
  )
}

// ── New Route form ────────────────────────────────────────────────────────────
