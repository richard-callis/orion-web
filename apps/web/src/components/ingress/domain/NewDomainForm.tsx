'use client'

import { useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import type { Domain } from '../types'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { apiFetch, errorMessage } from '@/lib/api'
import { useToast } from '@/components/ui/Toast'

export function NewDomainForm({ onCreated }: { onCreated: (d: Domain) => void }) {
  const [open, setOpen]     = useState(false)
  const [name, setName]     = useState('')
  const [type, setType]     = useState('public')
  const [saving, setSaving] = useState(false)
  const toast = useToast()

  const submit = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      const d = await apiFetch<Domain>('/api/ingress/domains', { method: 'POST', body: { name, type } })
      onCreated(d)
      setName(''); setType('public'); setOpen(false)
    } catch (e) {
      toast.error(`Failed to create domain: ${errorMessage(e)}`)
    } finally {
      setSaving(false)
    }
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} variant="secondary" className="w-full justify-center mt-2">
        <Plus size={12} /> Add domain
      </Button>
    )
  }
  return (
    <div className="mt-2 p-3 rounded-lg border border-border-subtle bg-bg-raised space-y-2">
      <Input
        autoFocus
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && submit()}
        placeholder="khalisio.com"
      />
      <Select value={type} onChange={e => setType(e.target.value)}>
        <option value="public">Public</option>
        <option value="internal">Internal (LAN only)</option>
      </Select>
      <div className="flex gap-2">
        <Button onClick={submit} disabled={saving || !name.trim()}>
          {saving ? <RefreshCw size={11} className="animate-spin" /> : <Plus size={11} />}
          Create
        </Button>
        <Button onClick={() => setOpen(false)} variant="secondary">Cancel</Button>
      </div>
    </div>
  )
}

// ── New Ingress Point form ────────────────────────────────────────────────────
