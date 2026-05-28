'use client'

import { Loader2 } from 'lucide-react'

interface Props {
  tokenCount: number
  tokenLimit: number | null
  onCompact?: () => void
  compacting?: boolean
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export default function ContextWindowBar({ tokenCount, tokenLimit, onCompact, compacting }: Props) {
  if (!tokenLimit) {
    if (!tokenCount) return null
    return (
      <span className="text-[10px] text-text-muted tabular-nums flex-shrink-0">
        {fmt(tokenCount)} tokens
      </span>
    )
  }

  const pct = Math.min(100, Math.round((tokenCount / tokenLimit) * 100))
  const remaining = tokenLimit - tokenCount

  const barColor =
    pct >= 90 ? 'bg-status-error' :
    pct >= 70 ? 'bg-status-warning' :
    'bg-status-healthy'

  return (
    <div
      className="flex items-center gap-1.5 flex-shrink-0"
      title={`${fmt(tokenCount)} / ${fmt(tokenLimit)} tokens (${pct}%)\nRemaining: ${fmt(remaining)}\nAuto-compacts at 90%`}
    >
      <div className="w-16 h-1.5 rounded-full bg-bg-raised overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] text-text-muted tabular-nums whitespace-nowrap">
        {fmt(tokenCount)} · {pct}%
      </span>
      {onCompact && (
        <button
          onClick={onCompact}
          disabled={compacting}
          className="text-[10px] px-1.5 py-0.5 rounded bg-bg-raised text-text-muted hover:text-text-primary hover:bg-bg-sidebar transition-colors flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
          title="Compact conversation history"
        >
          {compacting && <Loader2 size={10} className="animate-spin" />}
          {compacting ? 'Compacting…' : 'Compact'}
        </button>
      )}
    </div>
  )
}
