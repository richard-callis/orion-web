'use client'

import { useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Globe, Link2, RefreshCw, Server, Trash2 } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input, labelClass } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { apiFetch, errorMessage } from '@/lib/api'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { ModalHeader, ErrorNote, modalPanel } from '../shared'
import type { Environment } from '../types'

interface EnvForm {
  name: string; type: string; description: string; gatewayUrl: string; gatewayToken: string
  kubeconfig: string; nodeIp: string; talosConfig: string
  federationRole: string; federationToken: string; spokeUrl: string; hubUrl: string
}

const EMPTY_ENV: EnvForm = {
  name: '', type: 'cluster', description: '', gatewayUrl: '', gatewayToken: '', kubeconfig: '', nodeIp: '',
  talosConfig: '', federationRole: 'standalone', federationToken: '', spokeUrl: '', hubUrl: '',
}

const toB64 = (s: string) => btoa(unescape(encodeURIComponent(s)))

function formFromEnv(env: Environment): EnvForm {
  const meta = env.metadata ?? {}
  return {
    ...EMPTY_ENV,
    name: env.name,
    type: env.type,
    description: env.description ?? '',
    gatewayUrl: env.gatewayUrl ?? '',
    nodeIp: typeof meta.nodeIp === 'string' ? meta.nodeIp : '',
    federationRole: env.federationRole ?? 'standalone',
    spokeUrl: env.spokeUrl ?? '',
    hubUrl: env.hubUrl ?? '',
  }
}

export function EnvironmentFormModal({
  mode, env, onClose, onSaved, onDeleted,
}: {
  mode: 'create' | 'edit'
  env: Environment | null
  onClose: () => void
  onSaved: (env: Environment) => void
  onDeleted: (id: string) => void
}) {
  const [form, setForm] = useState<EnvForm>(() => (mode === 'edit' && env ? formFromEnv(env) : EMPTY_ENV))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = useId()
  const confirm = useConfirm()
  const set = (k: keyof EnvForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  const save = async () => {
    if (!form.name.trim()) { setError('Name is required'); return }
    setSaving(true); setError(null)
    try {
      const metadata: Record<string, unknown> = { ...(mode === 'edit' ? env?.metadata ?? {} : {}) }
      if (form.type === 'cluster') {
        if (form.nodeIp.trim()) metadata.nodeIp = form.nodeIp.trim()
        // Stored as base64 so it can be passed straight to gateway tools
        if (form.talosConfig.trim()) metadata.talosConfig = toB64(form.talosConfig.trim())
      }
      const payload = {
        name: form.name.trim(),
        type: form.type,
        description: form.description || null,
        gatewayUrl: form.gatewayUrl || null,
        gatewayToken: form.gatewayToken || undefined,
        kubeconfig: form.kubeconfig.trim() ? toB64(form.kubeconfig.trim()) : undefined,
        metadata,
        federationRole: form.federationRole && form.federationRole !== 'standalone' ? form.federationRole : null,
        // Blank keeps the stored token; switching to standalone clears it.
        federationToken: form.federationRole === 'standalone' ? null : (form.federationToken || undefined),
        spokeUrl: form.spokeUrl || null,
        hubUrl: form.hubUrl || null,
      }
      const saved = mode === 'create'
        ? await apiFetch<Environment>('/api/environments', { method: 'POST', body: payload })
        : await apiFetch<Environment>(`/api/environments/${env!.id}`, { method: 'PUT', body: payload })
      onSaved(saved)
    } catch (e) {
      setError(errorMessage(e, 'Failed to save'))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!env) return
    const ok = await confirm({
      title: `Delete ${env.name}?`,
      message: 'This removes the environment and its tools from ORION. It does not touch the cluster itself.',
      confirmLabel: 'Delete',
    })
    if (!ok) return
    try {
      await apiFetch(`/api/environments/${env.id}`, { method: 'DELETE' })
      onDeleted(env.id)
    } catch (e) {
      setError(`Failed to delete environment: ${errorMessage(e)}`)
    }
  }

  const generateToken = () => {
    const token = Array.from(crypto.getRandomValues(new Uint8Array(24)))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
    setForm(f => ({ ...f, federationToken: token }))
  }

  const f = (name: string) => `${id}-${name}`

  return createPortal(
    <Dialog
      onClose={onClose}
      label={mode === 'create' ? 'New environment' : `Edit ${env?.name ?? 'environment'}`}
      className={`${modalPanel} max-w-md`}
    >
      <ModalHeader title={mode === 'create' ? 'New Environment' : `Edit · ${env?.name}`} onClose={onClose} />

      <div className="p-5 space-y-3">
        {error && <ErrorNote>{error}</ErrorNote>}

        <div>
          <label htmlFor={f('name')} className={labelClass}>Name *</label>
          <Input id={f('name')} value={form.name} onChange={set('name')} placeholder="K3s Cluster" autoFocus />
        </div>
        <div>
          <label htmlFor={f('type')} className={labelClass}>Type</label>
          <Select id={f('type')} value={form.type} onChange={set('type')}>
            <option value="cluster">Cluster (kubectl)</option>
            <option value="docker">Docker Node</option>
            <option value="remote">Remote / Other</option>
          </Select>
        </div>
        <div>
          <label htmlFor={f('desc')} className={labelClass}>Description</label>
          <Input id={f('desc')} value={form.description} onChange={set('description')} placeholder="Main K3s homelab cluster" />
        </div>
        <div>
          <label htmlFor={f('gwurl')} className={labelClass}>
            <Link2 size={10} className="inline mr-1" aria-hidden />
            Gateway URL
          </label>
          <Input id={f('gwurl')} value={form.gatewayUrl} onChange={set('gatewayUrl')} placeholder="http://gateway.example.internal:3001" />
        </div>
        <div>
          <label htmlFor={f('gwtoken')} className={labelClass}>Gateway Token (leave blank to keep existing)</label>
          <Input id={f('gwtoken')} type="password" value={form.gatewayToken} onChange={set('gatewayToken')} placeholder="••••••••" autoComplete="off" />
        </div>
        {form.type === 'cluster' && (
          <>
            <div>
              <label htmlFor={f('nodeip')} className={labelClass}>
                <Server size={10} className="inline mr-1" aria-hidden />
                Control plane node IP
                <span className="text-text-muted ml-1">(used to auto-fetch kubeconfig)</span>
              </label>
              <Input id={f('nodeip')} value={form.nodeIp} onChange={set('nodeIp')} placeholder="192.168.1.100" />
              <p className="text-[10px] text-text-muted mt-1">
                ORION probes this IP to detect Talos (port 50000) or K3s (port 6443) and fetches credentials automatically.
              </p>
            </div>
            <div>
              <label htmlFor={f('kubeconfig')} className={labelClass}>
                Kubeconfig <span className="text-text-muted">(optional override — leave blank to auto-fetch)</span>
              </label>
              <Textarea id={f('kubeconfig')} value={form.kubeconfig} onChange={set('kubeconfig')}
                placeholder={'apiVersion: v1\nkind: Config\nclusters:\n  ...'} rows={4} className="font-mono text-[11px] resize-y leading-normal" />
            </div>
            <div>
              <label htmlFor={f('talos')} className={labelClass}>
                Talos Config{' '}
                <span className="text-text-muted">
                  {mode === 'edit' && env?.hasTalosConfig
                    ? '(set — leave blank to keep existing)'
                    : '(optional — enables auto-remediation of Talos prerequisites)'}
                </span>
              </label>
              <Textarea id={f('talos')} value={form.talosConfig} onChange={set('talosConfig')}
                placeholder={'context: <cluster-name>\ncontexts:\n  <cluster-name>:\n    endpoints: [...]\n    ca: ...\n    crt: ...\n    key: ...'}
                rows={4} className="font-mono text-[11px] resize-y leading-normal" />
              <p className="text-[10px] text-text-muted mt-1">
                Paste your <code className="font-mono">talosconfig</code> content here. Used by storage bootstrap to auto-install
                extensions (e.g. iscsi-tools) and reboot nodes. Leave blank to skip auto-remediation.
              </p>
            </div>
          </>
        )}

        <fieldset className="border-t border-border-subtle pt-4 mt-2">
          <legend className="sr-only">Federation</legend>
          <p className="text-xs font-medium text-text-secondary mb-3 flex items-center gap-1.5" aria-hidden>
            <Globe size={12} /> Federation
          </p>
          <div className="space-y-3">
            <div>
              <label htmlFor={f('fedrole')} className={labelClass}>Role</label>
              <Select id={f('fedrole')} value={form.federationRole} onChange={set('federationRole')}>
                <option value="standalone">Standalone (no federation)</option>
                <option value="hub">Hub (dispatch tasks to spokes)</option>
                <option value="spoke">Spoke (receive tasks from hub)</option>
              </Select>
            </div>
            <div>
              <label htmlFor={f('fedtoken')} className={labelClass}>
                Federation Token
                {mode === 'edit' && env?.hasFederationToken && <span className="text-text-muted"> (set — leave blank to keep existing)</span>}
              </label>
              <div className="flex gap-2">
                <Input id={f('fedtoken')} type="password" value={form.federationToken} onChange={set('federationToken')}
                  placeholder="Shared secret for hub↔spoke auth" />
                <Button variant="secondary" onClick={generateToken} className="shrink-0 whitespace-nowrap">Generate</Button>
              </div>
            </div>
            {form.federationRole === 'spoke' && (
              <>
                <div>
                  <label htmlFor={f('spoke')} className={labelClass}>Spoke URL <span className="text-text-muted">(this instance&apos;s base URL, reachable by the hub)</span></label>
                  <Input id={f('spoke')} value={form.spokeUrl} onChange={set('spokeUrl')} placeholder="https://spoke-orion.example.com" />
                </div>
                <div>
                  <label htmlFor={f('hub')} className={labelClass}>Hub URL <span className="text-text-muted">(URL of the hub instance)</span></label>
                  <Input id={f('hub')} value={form.hubUrl} onChange={set('hubUrl')} placeholder="https://hub-orion.example.com" />
                </div>
              </>
            )}
          </div>
        </fieldset>
      </div>

      <div className="flex items-center gap-2 px-5 py-4 border-t border-border-subtle">
        {mode === 'edit' && (
          <Button variant="danger" onClick={remove}>
            <Trash2 size={11} aria-hidden /> Delete
          </Button>
        )}
        <div className="flex-1" />
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={save} disabled={saving}>
          {saving ? <RefreshCw size={11} className="animate-spin" aria-hidden /> : <Check size={11} aria-hidden />}
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Dialog>,
    document.body,
  )
}
