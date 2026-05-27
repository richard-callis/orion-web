'use client'

import { useState } from 'react'

interface Props {
  tokenCount: number
  tokenLimit: number | null
  onCompact?: () => void
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export default function ContextWindowBar({ tokenCount, tokenLimit, onCompact }: Props) {
  const [expanded, setExpanded] = useState(false)

  if (!tokenLimit) return null

  const pct = Math.min(100, Math.round((tokenCount / tokenLimit) * 100))
  const remaining = tokenLimit - tokenCount
  const autoCompactAt = Math.round(tokenLimit * 0.9)

  const barColor =
    pct >= 90 ? 'bg-status-error' :
    pct >= 70 ? 'bg-status-warning' :
    'bg-status-healthy'

  return (
    <div className="px-4 py-1.5 border-b border-border-subtle flex-shrink-0">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full text-left"
        aria-label={`Context window: ${pct}% used`}
      >
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 rounded-full bg-bg-raised overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${barColor}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-[10px] text-text-muted tabular-nums whitespace-nowrap">
            {fmt(tokenCount)} / {fmt(tokenLimit)} · {pct}%
          </span>
        </div>
      </button>

      {expanded && (
        <div className="mt-2 text-[11px] text-text-muted space-y-1 pb-1">
          <div className="flex justify-between">
            <span>Used</span>
            <span className="tabular-nums">{fmt(tokenCount)} tokens</span>
          </div>
          <div className="flex justify-between">
            <span>Remaining</span>
            <span className="tabular-nums">{fmt(remaining)} tokens</span>
          </div>
          <div className="flex justify-between">
            <span>Limit</span>
            <span className="tabular-nums">{fmt(tokenLimit)} tokens</span>
          </div>
          <div className="flex justify-between opacity-60">
            <span>Auto-compacts at 90%</span>
            <span className="tabular-nums">{fmt(autoCompactAt)}</span>
          </div>
          {pct >= 60 && onCompact && (
            <button
              onClick={(e) => { e.stopPropagation(); onCompact() }}
              className="mt-1 w-full text-center py-1 rounded bg-bg-raised hover:bg-bg-sidebar text-text-muted text-[11px] transition-colors"
            >
              Compact Now
            </button>
          )}
        </div>
      )}
    </div>
  )
}
