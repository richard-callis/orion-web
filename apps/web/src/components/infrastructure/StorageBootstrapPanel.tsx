'use client'

import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Play, RefreshCw, Database, CheckCircle, XCircle, X } from 'lucide-react'

type StorageType = 'longhorn' | 'ceph'

interface Environment {
  id: string
  name: string
  type: string
  gatewayUrl: string | null
}

const btnPrimary = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors'
const selectCls  = 'text-xs bg-bg-raised border border-border-subtle rounded-lg px-2 py-1.5 text-text-primary focus:outline-none focus:ring-1 focus:ring-accent'

const STORAGE_OPTIONS: { value: StorageType; label: string; description: string }[] = [
  { value: 'longhorn', label: 'Longhorn',   description: 'Lightweight distributed block storage — ideal for small/medium clusters' },
  { value: 'ceph',     label: 'Rook-Ceph',  description: 'Production-grade distributed storage — requires 3+ nodes with raw disks' },
]

// ── Toast notification ─────────────────────────────────────────────────────────

interface ToastProps {
  message: string
  type: 'info' | 'error'
  onDismiss: () => void
}

function Toast({ message, type, onDismiss }: ToastProps) {
  useEffect(() => {
    if (type !== 'error') {
      const t = setTimeout(onDismiss, 8_000)
      return () => clearTimeout(t)
    }
  }, [type, onDismiss])

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      className={`fixed bottom-6 right-6 z-50 w-80 rounded-xl border shadow-2xl p-4 flex gap-3 animate-in slide-in-from-bottom-4 fade-in duration-200
        ${type === 'error' ? 'bg-bg-card border-status-error/40' : 'bg-bg-card border-accent/40'}`}
    >
      {type === 'error'
        ? <XCircle    size={18} className="text-status-error shrink-0 mt-0.5" />
        : <CheckCircle size={18} className="text-accent shrink-0 mt-0.5" />
      }
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-semibold ${type === 'error' ? 'text-status-error' : 'text-accent'}`}>
          {type === 'error' ? 'Bootstrap failed to start' : 'Bootstrap started'}
        </p>
        <p className="text-xs text-text-muted mt-1 leading-snug">{message}</p>
      </div>
      <button onClick={onDismiss} className="text-text-muted hover:text-text-primary shrink-0 p-0.5">
        <X size={13} />
      </button>
    </div>,
    document.body,
  )
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function StorageBootstrapPanel() {
  const [environments, setEnvironments] = useState<Environment[]>([])
  const [envId, setEnvId]               = useState('')
  const [storageType, setStorageType]   = useState<StorageType>('longhorn')
  const [running, setRunning]           = useState(false)
  const [toast, setToast]               = useState<{ message: string; type: 'info' | 'error' } | null>(null)

  useEffect(() => {
    fetch('/api/environments')
      .then(r => r.json())
      .then((envs: Environment[]) => {
        const clusters = envs.filter(e => e.type === 'cluster' && e.gatewayUrl)
        setEnvironments(clusters)
        if (clusters.length === 1) setEnvId(clusters[0].id)
      })
      .catch(() => {})
  }, [])

  const run = async () => {
    if (!envId) return
    setRunning(true)
    setToast(null)
    try {
      const res = await fetch('/api/storage/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ environmentId: envId, storageType }),
      })
      const data = await res.json() as { jobId?: string; error?: string }
      if (!res.ok || !data.jobId) {
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }
      setToast({ message: 'Check the Jobs panel (briefcase icon) for live progress.', type: 'info' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setToast({ message: msg, type: 'error' })
    } finally {
      setRunning(false)
    }
  }

  if (environments.length === 0) return null

  const selectedOption = STORAGE_OPTIONS.find(o => o.value === storageType)!

  return (
    <>
      <div className="rounded-lg border border-border-subtle bg-bg-card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Database size={13} className="text-accent" />
          <span className="text-sm font-semibold text-text-primary">Storage Bootstrap</span>
          <span className="text-xs text-text-muted">— deploy storage into a cluster environment</span>
        </div>

        {/* Storage type selector */}
        <div className="flex gap-2">
          {STORAGE_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => { if (!running) setStorageType(opt.value) }}
              disabled={running}
              className={`flex-1 rounded-lg border px-3 py-2 text-left transition-colors ${
                storageType === opt.value
                  ? 'border-accent bg-accent/10 text-text-primary'
                  : 'border-border-subtle bg-bg-raised text-text-muted hover:border-accent/50 hover:text-text-primary'
              }`}
            >
              <div className="text-xs font-semibold">{opt.label}</div>
              <div className="text-[10px] mt-0.5 leading-tight">{opt.description}</div>
            </button>
          ))}
        </div>

        {/* Environment + run */}
        <div className="flex items-center gap-2 flex-wrap">
          <select value={envId} onChange={e => setEnvId(e.target.value)} className={selectCls} disabled={running}>
            <option value="">Select environment…</option>
            {environments.map(e => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>

          <button onClick={run} disabled={running || !envId} className={btnPrimary}>
            {running
              ? <><RefreshCw size={11} className="animate-spin" /> Starting…</>
              : <><Play size={11} /> Bootstrap {selectedOption.label}</>
            }
          </button>
        </div>
      </div>

      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onDismiss={() => setToast(null)}
        />
      )}
    </>
  )
}
