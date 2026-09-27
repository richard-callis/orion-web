'use client'

import { ExternalLink, Server, Container, GitBranch, Rocket } from 'lucide-react'
import { ArgoCDSyncPanel } from './ArgoCDSyncPanel'
import type { Environment } from './types'

export function EnvironmentCard({
  env,
  openPrCount,
  selected,
  onSelect,
  onBootstrap,
}: {
  env: Environment
  openPrCount: number
  selected: boolean
  onSelect: (id: string) => void
  onBootstrap: (id: string, name: string, envType: string, hasKubeconfig: boolean) => void
}) {
  const hasRepo = !!(env.gitOwner && env.gitRepo)

  const statusDot =
    env.status === 'connected' ? 'bg-status-healthy' :
    env.status === 'error'     ? 'bg-status-error'    :
    'bg-text-muted'

  return (
    <div
      onClick={() => onSelect(env.id)}
      className={`bg-bg-surface border rounded-xl p-4 flex flex-col gap-3 cursor-pointer transition-colors ${
        selected
          ? 'border-accent ring-1 ring-accent/30'
          : 'border-border-subtle hover:border-accent/40'
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {env.type === 'docker'
            ? <Container size={16} className="text-text-muted flex-shrink-0" />
            : <Server size={16} className="text-text-muted flex-shrink-0" />
          }
          <span className="text-sm font-semibold text-text-primary truncate">{env.name}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Status dot */}
          <span className="flex items-center gap-1.5 text-xs text-text-muted">
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDot}`} />
            {env.status ?? 'unknown'}
          </span>
        </div>
      </div>

      {/* Gitea repo */}
      <div className="flex items-center gap-1.5 text-xs text-text-muted">
        <GitBranch size={12} className="flex-shrink-0" />
        {hasRepo ? (
          <span className="font-mono">{env.gitOwner}/{env.gitRepo}</span>
        ) : (
          <span className="italic text-text-muted/60">No repo configured</span>
        )}
      </div>

      {/* ArgoCD sync state */}
      {env.metadata?.argocd && (
        <ArgoCDSyncPanel argocd={env.metadata.argocd} />
      )}

      {/* Footer row: PR count + links */}
      <div className="flex items-center justify-between gap-2 pt-1">
        <div className="flex items-center gap-2">
          {/* Open PR badge */}
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${
            openPrCount > 0
              ? 'bg-status-warning/15 text-status-warning'
              : 'bg-bg-raised text-text-muted border border-border-subtle'
          }`}>
            {openPrCount} open PR{openPrCount !== 1 ? 's' : ''}
          </span>

          {/* ArgoCD link */}
          {env.argoCdUrl && (
            <a
              href={env.argoCdUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
            >
              <ExternalLink size={10} />
              ArgoCD
            </a>
          )}
        </div>

        {/* Bootstrap button */}
        {!hasRepo && (
          <button
            onClick={() => onBootstrap(env.id, env.name, env.type, !!env.hasKubeconfig)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-accent/10 text-accent border border-accent/30 hover:bg-accent/20 transition-colors font-medium"
          >
            <Rocket size={12} />
            Bootstrap
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────
