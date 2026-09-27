'use client'

import { useEffect, useRef, useState } from 'react'
import { ArrowUpCircle, Pencil, Rocket } from 'lucide-react'
import { Button, IconButton } from '@/components/ui/Button'
import { apiFetch, errorMessage } from '@/lib/api'
import { TYPE_ICONS } from './shared'
import { STATUS_DOT, type Environment } from './types'

const STATUS_BADGE: Record<string, string> = {
  connected: 'bg-status-healthy/15 text-status-healthy',
  error: 'bg-status-error/15 text-status-error',
}

export function EnvironmentHeader({ env, onBootstrap, onDeploy, onEdit }: {
  env: Environment
  onBootstrap: () => void
  onDeploy: () => void
  onEdit: () => void
}) {
  const [updating, setUpdating] = useState(false)
  const [updateMsg, setUpdateMsg] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const triggerUpdate = async () => {
    setUpdating(true)
    setUpdateMsg(null)
    try {
      const data = await apiFetch<{ ok?: boolean; message?: string; error?: string }>(`/api/environments/${env.id}/gateway`, { method: 'POST' })
      setUpdateMsg(data?.message ?? data?.error ?? 'Done')
    } catch (e) {
      setUpdateMsg(errorMessage(e, 'Update failed'))
    } finally {
      setUpdating(false)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setUpdateMsg(null), 5000)
    }
  }

  return (
    <div className="flex items-center gap-3 px-6 py-4 border-b border-border-subtle shrink-0">
      <span className="text-text-muted" aria-hidden>{TYPE_ICONS[env.type]}</span>
      <div className="flex-1 min-w-0">
        <h1 className="text-sm font-semibold text-text-primary">{env.name}</h1>
        <p className="text-xs text-text-muted mt-0.5">
          {env.gatewayUrl ?? 'No gateway URL configured'}
          {env.lastSeen && ` · last seen ${new Date(env.lastSeen).toLocaleTimeString()}`}
        </p>
      </div>
      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${STATUS_BADGE[env.status] ?? 'bg-bg-raised text-text-muted'}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[env.status] ?? 'bg-text-muted'}`} aria-hidden />
        {env.status}
      </span>
      {env.gatewayVersion && (
        <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-sm text-xs font-mono bg-bg-raised text-text-muted border border-border-subtle" title="Gateway version">
          v{env.gatewayVersion}
        </span>
      )}
      {env.status === 'connected' && (
        <Button variant="secondary" onClick={triggerUpdate} disabled={updating}
          title={updateMsg ?? 'Update gateway to latest image'} aria-live="polite">
          <ArrowUpCircle size={12} className={updating ? 'animate-spin' : ''} aria-hidden />
          {updating ? 'Updating…' : updateMsg ?? 'Update'}
        </Button>
      )}
      {env.type === 'cluster' ? (
        <Button onClick={onBootstrap} title="Bootstrap GitOps environment">
          <Rocket size={12} aria-hidden /> Bootstrap
        </Button>
      ) : (
        <Button onClick={onDeploy} title="Deploy gateway">
          <Rocket size={12} aria-hidden /> Deploy Gateway
        </Button>
      )}
      <IconButton label="Edit environment" onClick={onEdit} className="p-1.5 hover:text-accent hover:bg-bg-raised">
        <Pencil size={14} />
      </IconButton>
    </div>
  )
}
