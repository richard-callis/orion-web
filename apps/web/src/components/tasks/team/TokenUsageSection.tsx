'use client'
import useSWR from 'swr'
import { Coins } from 'lucide-react'

interface Period { inputTokens: number; outputTokens: number; total: number; budget: number | null; pct: number | null }
interface TokenUsageData {
  today: Period
  month: Period
  sparkline: Array<{ date: string; tokens: number }>
}

function UsageBar({ label, period }: { label: string; period: Period }) {
  const pct = period.pct ?? 0
  return (
    <div>
      <div className="flex justify-between text-[10px] text-text-muted mb-1">
        <span>{label}</span>
        <span>
          {period.total.toLocaleString()}
          {period.budget != null && ` / ${period.budget.toLocaleString()}`}
          {period.pct != null && ` (${period.pct}%)`}
        </span>
      </div>
      {period.budget != null && (
        <div className="w-full bg-bg-raised rounded-full h-1.5" role="progressbar" aria-label={`${label} token budget`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div
            className={`h-1.5 rounded-full transition-all ${pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-yellow-500' : 'bg-accent'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  )
}

export function TokenUsageSection({ agentId }: { agentId: string }) {
  const { data } = useSWR<TokenUsageData>(`/api/agents/${agentId}/token-usage`)
  if (!data) return null
  const sparkMax = Math.max(...data.sparkline.map(s => s.tokens), 1)

  return (
    <div className="rounded-lg border border-border-subtle p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-text-primary mb-1">
        <Coins size={12} className="text-accent" />
        Token Usage
      </div>
      <UsageBar label="Today" period={data.today} />
      <UsageBar label="This month" period={data.month} />
      {data.sparkline.length > 0 && (
        <div>
          <div className="text-[10px] text-text-muted mb-1">Last 7 days</div>
          <div className="flex items-end gap-px h-6">
            {data.sparkline.map(s => (
              <div
                key={s.date}
                className="flex-1 bg-accent/50 rounded-xs"
                style={{ height: `${Math.max(s.tokens > 0 ? 15 : 0, (s.tokens / sparkMax) * 100)}%` }}
                title={`${s.date}: ${s.tokens.toLocaleString()}`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
