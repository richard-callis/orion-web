'use client'

import type { ArgoCDState } from './types'
import { relativeTime } from './utils'

export const HEALTH_COLORS: Record<string, string> = {
  Healthy:     'text-status-healthy',
  Progressing: 'text-status-warning',
  Degraded:    'text-status-error',
  Suspended:   'text-text-muted',
  Missing:     'text-status-error',
  Unknown:     'text-text-muted',
}

export const SYNC_COLORS: Record<string, string> = {
  Synced:    'text-status-healthy',
  OutOfSync: 'text-status-warning',
  Unknown:   'text-text-muted',
}

export function ArgoCDSyncPanel({ argocd }: { argocd: ArgoCDState }) {
  const overallColor = HEALTH_COLORS[argocd.overallHealth] ?? 'text-text-muted'

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-raised p-2.5 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">ArgoCD</span>
        <span className={`text-xs font-semibold ${overallColor}`}>{argocd.overallHealth}</span>
      </div>
      {argocd.applications.map(app => (
        <div key={app.name} className="flex items-center justify-between text-xs gap-2">
          <span className="text-text-secondary font-mono truncate flex-1">{app.name}</span>
          <span className={`shrink-0 ${SYNC_COLORS[app.syncStatus] ?? 'text-text-muted'}`}>
            {app.syncStatus}
          </span>
          <span className={`shrink-0 ${HEALTH_COLORS[app.healthStatus] ?? 'text-text-muted'}`}>
            {app.healthStatus}
          </span>
        </div>
      ))}
      <p className="text-xs text-text-muted/60 pt-0.5">
        Reported {relativeTime(argocd.reportedAt)}
      </p>
    </div>
  )
}

// ─── Environment Card ─────────────────────────────────────────────────────────
