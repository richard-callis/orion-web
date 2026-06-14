'use client'
import { useState, useEffect } from 'react'
import { BarChart2, Coins, RefreshCw, TrendingUp, Zap, Calendar, Activity, Cpu, PiggyBank, DollarSign } from 'lucide-react'

type Days = 7 | 30 | 90

interface AgentRow {
  agentId: string
  agentName: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  savingsUsd: number
  tasks: number
  last7: number[]
}

interface DayRow {
  date: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  savingsUsd: number
}

interface ModelRow {
  modelId: string
  selfHosted: boolean
  inputTokens: number
  outputTokens: number
  costUsd: number
  savingsUsd: number
}

interface Summary {
  totalInputTokens: number
  totalOutputTokens: number
  totalCostUsd: number
  totalSavingsUsd: number
  totalTasks: number
  byAgent: AgentRow[]
  byModel: ModelRow[]
  byDay: DayRow[]
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function fmtUsd(n: number): string {
  if (n === 0) return '—'
  if (n < 0.01) return '<$0.01'
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

function Sparkline({ data }: { data: number[] }) {
  if (!data.length) return <div className="w-16 h-5" />
  const max = Math.max(...data, 1)
  return (
    <div className="flex items-end gap-px h-5 w-16">
      {data.map((v, i) => (
        <div
          key={i}
          className="flex-1 bg-accent/50 rounded-sm"
          style={{ height: `${Math.max(10, (v / max) * 100)}%` }}
          title={String(v)}
        />
      ))}
    </div>
  )
}

export default function CostPage() {
  const [days, setDays] = useState<Days>(30)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)

  const load = async (d: Days) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/cost/summary?days=${d}`)
      if (res.ok) setSummary(await res.json())
    } catch {}
    setLoading(false)
  }

  useEffect(() => { load(days) }, [days])

  const totalTokens = summary ? summary.totalInputTokens + summary.totalOutputTokens : 0
  const topSpender  = summary?.byAgent[0]
  const hasCost     = summary ? summary.totalCostUsd > 0 : false
  const hasSavings  = summary ? summary.totalSavingsUsd > 0 : false

  const busiestDay = summary?.byDay.reduce<DayRow | null>((best, d) =>
    !best || (d.inputTokens + d.outputTokens) > (best.inputTokens + best.outputTokens) ? d : best
  , null)

  const maxDayTokens = summary
    ? Math.max(...summary.byDay.map(d => d.inputTokens + d.outputTokens), 1)
    : 1

  return (
    <div className="flex flex-col h-full overflow-auto">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle flex-shrink-0">
        <div className="flex items-center gap-2">
          <Coins size={18} className="text-accent" />
          <h1 className="text-sm font-semibold text-text-primary">Token Usage & Cost</h1>
          {summary && (
            <p className="text-xs text-text-muted ml-2">
              {fmt(totalTokens)} tokens · {summary.totalTasks} tasks · {summary.byAgent.length} agents
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center border border-border-subtle rounded overflow-hidden">
            {([7, 30, 90] as Days[]).map(d => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`px-3 py-1 text-xs transition-colors ${
                  days === d
                    ? 'bg-accent/15 text-accent'
                    : 'text-text-muted hover:text-text-primary hover:bg-bg-raised'
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
          <button
            onClick={() => load(days)}
            className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-raised transition-colors"
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {loading ? (
          <div className="text-center py-8 text-text-muted text-sm">Loading usage data...</div>
        ) : summary ? (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="rounded-lg border border-border-subtle bg-bg-surface p-3">
                <div className="text-2xl font-bold text-text-primary">{fmt(totalTokens)}</div>
                <div className="text-[10px] text-text-muted mt-1 flex items-center gap-1">
                  <Zap size={10} /> Total Tokens
                </div>
                <div className="text-[10px] text-text-muted mt-0.5">
                  {fmt(summary.totalInputTokens)} in · {fmt(summary.totalOutputTokens)} out
                </div>
              </div>
              <div className="rounded-lg border border-border-subtle bg-bg-surface p-3">
                <div className="text-2xl font-bold text-text-primary">{summary.totalTasks}</div>
                <div className="text-[10px] text-text-muted mt-1 flex items-center gap-1">
                  <TrendingUp size={10} /> Total Tasks
                </div>
              </div>
              {hasCost ? (
                <div className="rounded-lg border border-status-error/30 bg-status-error/5 p-3">
                  <div className="text-2xl font-bold text-status-error">{fmtUsd(summary.totalCostUsd)}</div>
                  <div className="text-[10px] text-text-muted mt-1 flex items-center gap-1">
                    <DollarSign size={10} /> API Spend
                  </div>
                  <div className="text-[10px] text-text-muted mt-0.5">last {days} days</div>
                </div>
              ) : (
                <div className="rounded-lg border border-border-subtle bg-bg-surface p-3">
                  <div className="text-sm font-bold text-text-primary truncate" title={topSpender?.agentName}>
                    {topSpender?.agentName ?? '—'}
                  </div>
                  <div className="text-[10px] text-text-muted mt-1">
                    {topSpender ? fmt(topSpender.inputTokens + topSpender.outputTokens) + ' tokens' : ''}
                  </div>
                  <div className="text-[10px] text-text-muted mt-0.5 flex items-center gap-1">
                    <BarChart2 size={10} /> Top Spender
                  </div>
                </div>
              )}
              {hasSavings ? (
                <div className="rounded-lg border border-status-healthy/30 bg-status-healthy/5 p-3">
                  <div className="text-2xl font-bold text-status-healthy">{fmtUsd(summary.totalSavingsUsd)}</div>
                  <div className="text-[10px] text-text-muted mt-1 flex items-center gap-1">
                    <PiggyBank size={10} /> Estimated Savings
                  </div>
                  <div className="text-[10px] text-text-muted mt-0.5">vs. cloud equivalent</div>
                </div>
              ) : (
                <div className="rounded-lg border border-border-subtle bg-bg-surface p-3">
                  <div className="text-sm font-bold text-text-primary">
                    {busiestDay?.date ?? '—'}
                  </div>
                  <div className="text-[10px] text-text-muted mt-1">
                    {busiestDay ? fmt(busiestDay.inputTokens + busiestDay.outputTokens) + ' tokens' : ''}
                  </div>
                  <div className="text-[10px] text-text-muted mt-0.5 flex items-center gap-1">
                    <Calendar size={10} /> Busiest Day
                  </div>
                </div>
              )}
            </div>

            {/* Daily bar chart */}
            <div className="rounded-lg border border-border-subtle bg-bg-surface p-4">
              <h3 className="text-xs font-medium text-text-primary mb-3 flex items-center gap-1.5">
                <BarChart2 size={13} className="text-accent" />
                Daily Token Usage — last {days} days
              </h3>
              <div className="flex items-end gap-px" style={{ height: '120px' }}>
                {summary.byDay.map((d, i) => {
                  const total = d.inputTokens + d.outputTokens
                  const pct   = (total / maxDayTokens) * 100
                  const showLabel = i % 5 === 0
                  const tip = `${d.date}: ${fmt(total)} tokens${d.costUsd > 0 ? ` · ${fmtUsd(d.costUsd)}` : ''}${d.savingsUsd > 0 ? ` · ${fmtUsd(d.savingsUsd)} saved` : ''}`
                  return (
                    <div key={d.date} className="flex-1 flex flex-col items-center justify-end gap-0.5 min-w-0">
                      <div
                        className="w-full bg-accent/50 hover:bg-accent/80 rounded-t-sm transition-colors cursor-default"
                        style={{ height: `${Math.max(pct, total > 0 ? 3 : 0)}%` }}
                        title={tip}
                      />
                      {showLabel && (
                        <span className="text-[8px] text-text-muted truncate w-full text-center leading-tight">
                          {d.date.slice(5)}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            {/* By-agent table */}
            {summary.byAgent.length > 0 && (
              <div className="rounded-lg border border-border-subtle bg-bg-surface p-4">
                <h3 className="text-xs font-medium text-text-primary mb-3 flex items-center gap-1.5">
                  <TrendingUp size={13} className="text-accent" />
                  Per-Agent Breakdown
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-text-muted border-b border-border-subtle">
                        <th className="text-left pb-2 font-medium">Agent</th>
                        <th className="text-right pb-2 font-medium">Input</th>
                        <th className="text-right pb-2 font-medium">Output</th>
                        <th className="text-right pb-2 font-medium">Total</th>
                        {hasCost    && <th className="text-right pb-2 font-medium text-status-error">Spend</th>}
                        {hasSavings && <th className="text-right pb-2 font-medium text-status-healthy">Saved</th>}
                        <th className="text-right pb-2 font-medium">Tasks</th>
                        <th className="text-right pb-2 font-medium">Last 7d</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.byAgent.map(a => {
                        const total    = a.inputTokens + a.outputTokens
                        const maxTotal = (summary.byAgent[0].inputTokens + summary.byAgent[0].outputTokens) || 1
                        const barPct   = (total / maxTotal) * 100
                        return (
                          <tr key={a.agentId} className="border-b border-border-subtle/50 last:border-0">
                            <td className="py-2 pr-2">
                              <div className="font-medium text-text-primary truncate max-w-[150px]" title={a.agentName}>
                                {a.agentName}
                              </div>
                              <div className="w-full bg-bg-raised rounded-full h-1 mt-1">
                                <div className="h-1 rounded-full bg-accent/60" style={{ width: `${barPct}%` }} />
                              </div>
                            </td>
                            <td className="py-2 text-right text-text-secondary">{fmt(a.inputTokens)}</td>
                            <td className="py-2 text-right text-text-secondary">{fmt(a.outputTokens)}</td>
                            <td className="py-2 text-right font-medium text-text-primary">{fmt(total)}</td>
                            {hasCost    && <td className="py-2 text-right text-status-error">{fmtUsd(a.costUsd)}</td>}
                            {hasSavings && <td className="py-2 text-right text-status-healthy">{fmtUsd(a.savingsUsd)}</td>}
                            <td className="py-2 text-right text-text-secondary">{a.tasks}</td>
                            <td className="py-2 pl-2"><Sparkline data={a.last7} /></td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* By-model table */}
            {summary.byModel.length > 0 && (
              <div className="rounded-lg border border-border-subtle bg-bg-surface overflow-hidden">
                <div className="px-4 py-3 border-b border-border-subtle flex items-center gap-2">
                  <Cpu size={13} className="text-accent" />
                  <h2 className="text-sm font-semibold text-text-primary">By Model</h2>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-bg-raised border-b border-border-subtle">
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-text-secondary">Model</th>
                        <th className="px-4 py-2.5 text-right text-xs font-medium text-text-secondary">Input</th>
                        <th className="px-4 py-2.5 text-right text-xs font-medium text-text-secondary">Output</th>
                        <th className="px-4 py-2.5 text-right text-xs font-medium text-text-secondary">Total</th>
                        {hasCost    && <th className="px-4 py-2.5 text-right text-xs font-medium text-status-error">Spend</th>}
                        {hasSavings && <th className="px-4 py-2.5 text-right text-xs font-medium text-status-healthy">Savings</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-subtle">
                      {summary.byModel.map(m => (
                        <tr key={m.modelId} className="hover:bg-bg-raised/50 transition-colors">
                          <td className="px-4 py-2.5 font-mono text-xs text-text-primary">
                            {m.modelId}
                            {m.selfHosted && (
                              <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] bg-accent/10 text-accent">self-hosted</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-right text-xs text-text-secondary">{fmt(m.inputTokens)}</td>
                          <td className="px-4 py-2.5 text-right text-xs text-text-secondary">{fmt(m.outputTokens)}</td>
                          <td className="px-4 py-2.5 text-right text-xs font-medium text-text-primary">{fmt(m.inputTokens + m.outputTokens)}</td>
                          {hasCost    && <td className="px-4 py-2.5 text-right text-xs text-status-error">{fmtUsd(m.costUsd)}</td>}
                          {hasSavings && <td className="px-4 py-2.5 text-right text-xs text-status-healthy">{fmtUsd(m.savingsUsd)}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {summary.byAgent.length === 0 && (
              <div className="flex flex-col items-center justify-center rounded-lg border border-border-subtle bg-bg-surface py-16 text-center gap-3">
                <Activity size={32} className="text-text-muted/40" />
                <p className="text-sm font-medium text-text-secondary">No token usage recorded yet</p>
                <p className="text-xs text-text-muted max-w-xs">Token usage will appear here once agents start completing tasks. Set pricing on your models in Admin → Models to track spend and savings.</p>
              </div>
            )}
          </>
        ) : (
          <div className="text-center py-8 text-text-muted text-sm">Failed to load data.</div>
        )}
      </div>
    </div>
  )
}
