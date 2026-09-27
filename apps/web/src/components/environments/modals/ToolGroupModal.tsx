'use client'

import { useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, RefreshCw } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { useToast } from '@/components/ui/Toast'
import { apiFetch, errorMessage } from '@/lib/api'
import { ModalHeader, modalPanel } from '../shared'
import type { ToolGroup } from '../types'

const labelCls = 'block text-xs text-text-muted mb-1'

export function ToolGroupModal({ envId, group, onClose, onSaved }: {
  envId: string
  /** null = create */
  group: ToolGroup | null
  onClose: () => void
  onSaved: () => void
}) {
  const toast = useToast()
  const id = useId()
  const [form, setForm] = useState({
    name: group?.name ?? '',
    description: group?.description ?? '',
    minimumTier: group?.minimumTier ?? 'viewer',
  })
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!form.name.trim()) return
    setSaving(true)
    const body = { name: form.name.trim(), description: form.description.trim() || null, minimumTier: form.minimumTier }
    try {
      if (group) await apiFetch(`/api/tool-groups/${group.id}`, { method: 'PUT', body })
      else await apiFetch('/api/tool-groups', { method: 'POST', body: { ...body, environmentId: envId } })
      onSaved()
    } catch (e) {
      toast.error(`Failed to save tool group: ${errorMessage(e)}`)
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <Dialog onClose={onClose} label={group ? `Edit ${group.name}` : 'New tool group'} className={`${modalPanel} max-w-sm`}>
      <ModalHeader title={group ? `Edit · ${group.name}` : 'New Tool Group'} onClose={onClose} />
      <div className="p-5 space-y-3">
        <div>
          <label htmlFor={`${id}-name`} className={labelCls}>Name *</label>
          <Input id={`${id}-name`} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Kubernetes Read-only" autoFocus />
        </div>
        <div>
          <label htmlFor={`${id}-desc`} className={labelCls}>Description</label>
          <Input id={`${id}-desc`} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Optional" />
        </div>
        <div>
          <label htmlFor={`${id}-tier`} className={labelCls}>Minimum tier to run without approval</label>
          <Select id={`${id}-tier`} value={form.minimumTier} onChange={e => setForm(f => ({ ...f, minimumTier: e.target.value }))}>
            <option value="viewer">viewer — anyone</option>
            <option value="operator">operator — operators and above</option>
            <option value="admin">admin — admins only</option>
          </Select>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border-subtle">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={save} disabled={saving || !form.name.trim()}>
          {saving ? <RefreshCw size={11} className="animate-spin" aria-hidden /> : <Check size={11} aria-hidden />}
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Dialog>,
    document.body,
  )
}
