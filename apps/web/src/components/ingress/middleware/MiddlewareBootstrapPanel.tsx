'use client'

import { useState, useEffect } from 'react'
import useSWR from 'swr'
import type { LucideIcon } from 'lucide-react'
import { apiFetch, errorMessage } from '@/lib/api'
import { Check, X, RefreshCw, Lock, AlertCircle, Shield, Zap, ShieldCheck, Play, KeyRound, Bot, Gauge, Package } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'

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

export const NOVA_ICONS: Record<string, LucideIcon> = { Shield, ShieldCheck, Gauge, Lock, KeyRound, Bot, Zap, Package }

export function getNovaIcon(iconName?: string): LucideIcon {
  return NOVA_ICONS[iconName ?? ''] ?? Package
}

export function MiddlewareBootstrapPanel({ pointId }: { pointId: string }) {
  const { data, error: loadError, isLoading: loading } =
    useSWR<{ novae?: MiddlewareNova[] }>('/api/novas?tag=middleware&type=service', { revalidateOnFocus: false })
  const novas = data?.novae ?? []
  const fetchError = loadError ? errorMessage(loadError) : null
  const [modal, setModal] = useState<string | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null)

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
      const started = await apiFetch<{ jobId?: string }>(`/api/ingress/points/${pointId}/bootstrap-middleware`, {
        method: 'POST',
        body: { novaName },
      })
      if (!started?.jobId) throw new Error('Bootstrap did not start (no job id returned)')
      const label = novas.find(n => n.name === novaName)?.displayName ?? novaName
      setNotice({ text: `${label} bootstrap started — check the Jobs panel for progress.`, ok: true })
    } catch (e) {
      setNotice({ text: errorMessage(e), ok: false })
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
              const Icon = getNovaIcon(nova.config?.icon)
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
        const Icon = getNovaIcon(selectedNova.config?.icon)
        const setupNote = selectedNova.config?.setupNote
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
              <button aria-label="Close" onClick={() => setModal(null)} className="text-text-muted hover:text-text-primary"><X size={16} /></button>
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
                <Button onClick={() => setModal(null)} variant="secondary">Cancel</Button>
                <Button
                  onClick={() => { runBootstrap(modal) }}
                  disabled={running !== null}
                >
                  {running === modal
                    ? <><RefreshCw size={11} className="animate-spin" /> Deploying…</>
                    : <><Play size={11} /> Deploy</>
                  }
                </Button>
              </div>
            </div>
          </Dialog>
        )
      })()}
    </>
  )
}

// ── New Domain form ───────────────────────────────────────────────────────────
