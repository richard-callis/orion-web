'use client'

import { ExternalLink, CheckCircle } from 'lucide-react'
import type { GitOpsPR } from './types'
import { relativeTime } from './utils'

export function PRTable({ prs, showStatus }: { prs: GitOpsPR[]; showStatus?: boolean }) {
  if (prs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-14 gap-3 text-text-muted">
        <CheckCircle size={32} className="text-status-healthy opacity-60" />
        <p className="text-sm font-medium text-text-secondary">
          {showStatus ? 'No closed PRs yet' : 'No open PRs — the cluster is in sync'}
        </p>
      </div>
    )
  }

  const cols = showStatus
    ? ['Environment', 'Operation', 'Title', 'Status', 'Merged', 'Actions']
    : ['Environment', 'Operation', 'Title', 'Decision', 'Opened', 'Actions']

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-bg-raised border-b border-border-subtle">
          <tr>
            {cols.map(h => (
              <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-text-muted">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {prs.map(pr => (
            <tr
              key={pr.id}
              className={`hover:bg-bg-raised transition-colors ${
                !showStatus && pr.decision === 'review' ? 'border-l-2 border-l-status-warning' : ''
              }`}
            >
              <td className="px-4 py-3 text-text-secondary text-xs font-medium whitespace-nowrap">
                {pr.environment.name}
              </td>
              <td className="px-4 py-3 whitespace-nowrap">
                <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-xs bg-bg-raised border border-border-subtle text-text-muted font-mono">
                  {pr.operation}
                </span>
              </td>
              <td className="px-4 py-3 max-w-[260px]">
                <a
                  href={pr.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline truncate block"
                  title={pr.title}
                >
                  {pr.title}
                </a>
              </td>
              <td className="px-4 py-3 whitespace-nowrap">
                {showStatus ? (
                  pr.status === 'merged' ? (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-status-healthy/10 text-status-healthy">
                      merged
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-text-muted/10 text-text-muted">
                      closed
                    </span>
                  )
                ) : pr.decision === 'auto' ? (
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-status-healthy/10 text-status-healthy">
                    auto-merge
                  </span>
                ) : (
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-status-warning/10 text-status-warning">
                    needs review
                  </span>
                )}
              </td>
              <td className="px-4 py-3 text-xs text-text-muted whitespace-nowrap">
                {showStatus
                  ? (pr.mergedAt ? relativeTime(pr.mergedAt) : relativeTime(pr.createdAt))
                  : relativeTime(pr.createdAt)
                }
              </td>
              <td className="px-4 py-3">
                <a
                  href={pr.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-sm border border-border-subtle bg-bg-raised text-text-secondary hover:text-text-primary hover:border-accent transition-colors"
                >
                  <ExternalLink size={11} />
                  View
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── ArgoCD Sync Panel ────────────────────────────────────────────────────────
