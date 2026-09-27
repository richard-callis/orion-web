'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { errorMessage } from '@/lib/api'
import { RefreshCw, X, AlertCircle } from 'lucide-react'
import { KpiCard } from '@/components/dashboard/KpiCard'
import { BootstrapModal } from './BootstrapModal'
import { EnvironmentCard } from './EnvironmentCard'
import { PRTable } from './PRTable'
import type { GitOpsPR, Environment } from './types'
import { isToday } from './utils'

export function GitOpsPage() {
  const prsQ = useSWR<GitOpsPR[]>('/api/gitops/prs')
  const envsQ = useSWR<Environment[]>('/api/environments')
  const prs = prsQ.data ?? []
  const environments = envsQ.data ?? []
  const loading = prsQ.isLoading || envsQ.isLoading
  const refreshing = prsQ.isValidating || envsQ.isValidating
  const loadError = prsQ.error ?? envsQ.error
  const error = loadError ? errorMessage(loadError, 'Failed to fetch data') : null
  const load = () => { void prsQ.mutate(); void envsQ.mutate() }
  const [bootstrapTarget, setBootstrapTarget] = useState<{ id: string; name: string; envType: string; hasKubeconfig: boolean } | null>(null)
  const [prTab, setPrTab] = useState<'open' | 'closed'>('open')
  const [selectedEnvId, setSelectedEnvId] = useState<string | null>(null)

  // Derived counts
  const filteredPRs = selectedEnvId ? prs.filter(p => p.environmentId === selectedEnvId) : prs
  const openPRs = filteredPRs.filter(p => p.status === 'open')
  const closedPRs = filteredPRs.filter(p => p.status === 'merged' || p.status === 'closed')
  const awaitingReview = prs.filter(p => p.status === 'open' && p.decision === 'review').length
  const autoMergedToday = prs.filter(p => p.status === 'merged' && isToday(p.mergedAt)).length

  // Per-environment open PR counts (always unfiltered for badges)
  const openByEnv: Record<string, number> = {}
  for (const pr of prs.filter(p => p.status === 'open')) {
    openByEnv[pr.environmentId] = (openByEnv[pr.environmentId] ?? 0) + 1
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-text-primary">GitOps</h1>
          <p className="text-sm text-text-muted mt-0.5">AI-proposed changes and PR status</p>
        </div>
        <button
          onClick={load}
          disabled={refreshing}
          className="inline-flex items-center gap-2 px-3 py-2 text-sm rounded-sm border border-border-subtle bg-bg-raised text-text-secondary hover:text-text-primary hover:border-accent transition-colors disabled:opacity-50"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} aria-hidden />
          Refresh
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div role="alert" className="flex items-center gap-2 px-4 py-3 rounded-lg border border-status-error/40 bg-status-error/10 text-status-error text-sm">
          <AlertCircle size={15} />
          {error}
        </div>
      )}

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Awaiting Review"    value={awaitingReview}       color="warning" />
        <KpiCard label="Auto-Merged Today"  value={autoMergedToday}      color="healthy" />
        <KpiCard label="Total Environments" value={environments.length}   color="info"    />
        <KpiCard label="Open PRs"           value={openPRs.length}       color="info"    />
      </div>

      {/* PR tabs */}
      <div className="bg-bg-surface border border-border-subtle rounded-xl overflow-hidden">
        {/* Tab bar */}
        <div className="flex items-center justify-between border-b border-border-subtle px-2 pt-1">
        <div className="flex items-center" role="tablist" aria-label="Pull requests">
          <button
            role="tab"
            aria-selected={prTab === 'open'}
            onClick={() => setPrTab('open')}
            className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors ${
              prTab === 'open'
                ? 'border-accent text-text-primary'
                : 'border-transparent text-text-muted hover:text-text-secondary'
            }`}
          >
            Open
            {openPRs.length > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] bg-status-warning/20 text-status-warning">
                {openPRs.length}
              </span>
            )}
          </button>
          <button
            role="tab"
            aria-selected={prTab === 'closed'}
            onClick={() => setPrTab('closed')}
            className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors ${
              prTab === 'closed'
                ? 'border-accent text-text-primary'
                : 'border-transparent text-text-muted hover:text-text-secondary'
            }`}
          >
            Closed
            {closedPRs.length > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] bg-bg-raised text-text-muted border border-border-subtle">
                {closedPRs.length}
              </span>
            )}
          </button>
        </div>
          {selectedEnvId && (
            <span className="text-xs text-text-muted pr-2 pb-1">
              {environments.find(e => e.id === selectedEnvId)?.name}
            </span>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12 gap-2 text-text-muted text-sm">
            <RefreshCw size={14} className="animate-spin" />
            Loading…
          </div>
        ) : prTab === 'open' ? (
          <PRTable prs={openPRs} />
        ) : (
          <PRTable prs={closedPRs} showStatus />
        )}
      </div>

      {/* Environments grid */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-text-primary">Environments</h2>
          {selectedEnvId && (
            <button
              onClick={() => setSelectedEnvId(null)}
              className="inline-flex items-center gap-1 text-xs text-accent hover:text-text-primary transition-colors"
            >
              <X size={12} />
              Clear filter
            </button>
          )}
        </div>
        {loading ? (
          <div className="flex items-center gap-2 text-text-muted text-sm">
            <RefreshCw size={14} className="animate-spin" />
            Loading…
          </div>
        ) : environments.length === 0 ? (
          <p className="text-sm text-text-muted">No environments configured.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {environments.map(env => (
              <EnvironmentCard
                key={env.id}
                env={env}
                openPrCount={openByEnv[env.id] ?? 0}
                selected={selectedEnvId === env.id}
                onSelect={id => setSelectedEnvId(prev => prev === id ? null : id)}
                onBootstrap={(id, name, envType, hasKubeconfig) => setBootstrapTarget({ id, name, envType, hasKubeconfig })}
              />
            ))}
          </div>
        )}
      </div>

      {/* Bootstrap modal */}
      {bootstrapTarget && (
        <BootstrapModal
          envId={bootstrapTarget.id}
          envName={bootstrapTarget.name}
          envType={bootstrapTarget.envType}
          hasKubeconfig={bootstrapTarget.hasKubeconfig}
          onClose={() => { setBootstrapTarget(null); load() }}
        />
      )}
    </div>
  )
}
