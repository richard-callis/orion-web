'use client'

import { useState, useEffect } from 'react'
import { Check, X, RefreshCw, Lock, AlertCircle, Shield, Zap, ShieldCheck, Play, KeyRound, Bot, Gauge, Package } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { btnPrimary, btnGhost } from '../styles'
import type { Domain } from '../types'

export interface MiddlewareNova {
  name: string
  displayName: string
  description: string | null
  tags: string[]
  config: {
    icon?: string
    setupNote?: string
    [key: string]: unknown
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const NOVA_ICONS: Record<string, any> = { Shield, ShieldCheck, Gauge, Lock, KeyRound, Bot, Zap, Package }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getNovaIcon(iconName?: string): any {
  return NOVA_ICONS[iconName ?? ''] ?? Package
}

export function MiddlewareBootstrapPanel({ pointId }: { pointId: string }) {
  const [novas, setNovas] = useState<MiddlewareNova[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [modal, setModal] = useState<string | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null)

  useEffect(() => {
    fetch('/api/novas?tag=middleware&type=service')
      .then(r => r.json())
      .then(data => {
        setNovas(data.novae ?? [])
        setLoading(false)
      })
      .catch(e => {
        setFetchError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
  }, [])

  // Auto-close the modal after a successful bootstrap
  useEffect(() => {
    if (notice?.ok && !running) {
      const timer = setTimeout(() => setModal(null), 1500)
      return () => clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notice])

  const runBootstrap = async (novaName: string) => {
    setRunning(novaName); setNotice(null)
    try {
      const res = await fetch(`/api/ingress/points/${pointId}/bootstrap-middleware`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ novaName }),
      })
      const data = await res.json()
      if (!res.ok || !data.jobId) throw new Error(data.error ?? `HTTP ${res.status}`)
      const label = novas.find(n => n.name === novaName)?.displayName ?? novaName
      setNotice({ text: `${label} bootstrap started — check the Jobs panel for progress.`, ok: true })
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : String(e), ok: false })
    } finally {
      setRunning(null)
    }
  }

  const selectedNova = novas.find(n => n.name === modal)

  return (
    <>
      <div className="mt-3 pt-3 border-t border-border-subtle">
        <p className="text-[11px] font-medium text-text-muted mb-2">Deploy Infrastructure Middleware</p>

        {loading && (
          <div className="flex items-center gap-2 py-2 text-[11px] text-text-muted">
            <RefreshCw size={11} className="animate-spin" /> Loading middleware catalog…
          </div>
        )}

        {fetchError && (
          <p className="text-[11px] text-status-error flex items-center gap-1">
            <AlertCircle size={11} /> {fetchError}
          </p>
        )}

        {!loading && !fetchError && (
          <div className="grid grid-cols-2 gap-2">
            {novas.map(nova => {
              const Icon = getNovaIcon((nova.config as any)?.icon)
              const isRunning = running === nova.name
              return (
                <button
                  key={nova.name}
                  onClick={() => setModal(nova.name)}
                  disabled={isRunning}
                  className={`flex flex-col items-center gap-1.5 p-3 rounded-lg border border-border-subtle text-center transition-colors hover:bg-bg-raised hover:border-accent/40 ${isRunning ? 'opacity-50 cursor-wait' : ''}`}
                >
                  <Icon size={18} className="text-accent" />
                  <span className="text-[11px] font-medium text-text-primary">{nova.displayName}</span>
                </button>
              )
            })}
          </div>
        )}

        {notice && (
          <p className={`text-xs mt-2 flex items-center gap-1 ${notice.ok ? 'text-status-healthy' : 'text-status-error'}`}>
            {notice.ok ? <Check size={12} /> : <AlertCircle size={12} />} {notice.text}
          </p>
        )}
      </div>

      {/* Inline middleware bootstrap modal */}
      {modal && selectedNova && (() => {
        const Icon = getNovaIcon((selectedNova.config as any)?.icon)
        const setupNote = (selectedNova.config as any)?.setupNote as string | undefined
        return (
          <Dialog
            onClose={() => setModal(null)}
            label={`Deploy ${selectedNova.displayName}`}
            className="w-full max-w-md bg-[#1e1e2e] border border-border-subtle rounded-xl shadow-2xl"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
              <div className="flex items-center gap-3">
                <Icon size={18} className="text-accent" />
                <div>
                  <h2 className="text-sm font-semibold text-text-primary">Deploy {selectedNova.displayName}</h2>
                  <p className="text-[11px] text-text-muted">{selectedNova.description}</p>
                </div>
              </div>
              <button onClick={() => setModal(null)} className="text-text-muted hover:text-text-primary"><X size={16} /></button>
            </div>
            <div className="px-5 py-4 space-y-3">
              <p className="text-xs text-text-muted">
                This will deploy <strong>{selectedNova.displayName}</strong> into your cluster via the associated environment.
                All config is managed through ORION playbooks.
              </p>
              {setupNote && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                  <p className="text-[11px] font-medium text-amber-400 mb-1">Post-install steps</p>
                  <pre className="text-[10px] text-amber-300/80 whitespace-pre-wrap font-mono">{setupNote}</pre>
                </div>
              )}
              <div className="flex gap-2">
                <button onClick={() => setModal(null)} className={btnGhost}>Cancel</button>
                <button
                  onClick={() => { runBootstrap(modal) }}
                  disabled={running !== null}
                  className={btnPrimary}
                >
                  {running === modal
                    ? <><RefreshCw size={11} className="animate-spin" /> Deploying…</>
                    : <><Play size={11} /> Deploy</>
                  }
                </button>
              </div>
            </div>
          </Dialog>
        )
      })()}
    </>
  )
}

// ── New Domain form ───────────────────────────────────────────────────────────
