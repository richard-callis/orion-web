'use client'

import { useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import { MIDDLEWARE_TYPES } from './middlewareTypes'
import type { IngressMiddleware } from '../types'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { apiFetch, errorMessage } from '@/lib/api'
import { useToast } from '@/components/ui/Toast'

export function NewMiddlewareForm({ pointId, onCreated }: { pointId: string; onCreated: (m: IngressMiddleware) => void }) {
  const [open, setOpen]     = useState(false)
  const [name, setName]     = useState('')
  const [type, setType]     = useState('crowdsec')
  const [namespace, setNs]  = useState('security')
  const [saving, setSaving] = useState(false)
  const toast = useToast()

  const submit = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      const m = await apiFetch<IngressMiddleware>(`/api/ingress/points/${pointId}/middlewares`, {
        method: 'POST',
        body: { name: name.trim(), type, config: { namespace } },
      })
      onCreated(m)
      setName(''); setType('crowdsec'); setNs('security'); setOpen(false)
    } catch (e) {
      toast.error(`Failed to create middleware: ${errorMessage(e)}`)
    } finally {
      setSaving(false)
    }
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} variant="secondary" className="text-[11px] w-full justify-center mt-1">
        <Plus size={10} /> Add middleware
      </Button>
    )
  }

  return (
    <div className="mt-2 p-3 rounded-lg border border-border-subtle bg-bg-raised space-y-2 text-xs">
      <div className="grid grid-cols-2 gap-2">
        <Input
          autoFocus
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
          placeholder="e.g. crowdsec-bouncer"
        />
        <Select value={type} onChange={e => setType(e.target.value)}>
          {MIDDLEWARE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </Select>
      </div>
      <Input
        value={namespace}
        onChange={e => setNs(e.target.value)}
        placeholder="Namespace (e.g. security)"
      />
      <div className="flex gap-2">
        <Button onClick={submit} disabled={saving || !name.trim()}>
          {saving ? <RefreshCw size={11} className="animate-spin" /> : <Plus size={11} />} Add
        </Button>
        <Button onClick={() => setOpen(false)} variant="secondary">Cancel</Button>
      </div>
    </div>
  )
}

// ── SSO Provider bootstrap ───────────────────────────────────────────────────
