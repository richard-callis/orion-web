'use client'
import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import {
  MessageSquare, Wrench, Bot, Play, RotateCcw, ChevronDown, ChevronUp,
  Clock, Terminal, Sparkles,
} from 'lucide-react'

interface TraceEntry {
  id: string
  conversationId: string | null
  taskId: string | null
  step: number
  type: string // "tool_call" | "tool_result" | "skill_injected" | "hook_triggered" | "text_generation" | "error"
  toolName: string | null
  toolArgs: string | null
  toolResult: string | null
  content: string | null
  skillName: string | null
  hookName: string | null
  durationMs: number | null
  modelUsed: string | null
  systemPromptHash: string | null
  tokensIn: number | null
  tokensOut: number | null
  costCents: number | null
  createdAt: string
}

const TYPE_CONFIG: Record<string, {
  icon: React.ReactNode
  color: string
  bg: string
  label: string
}> = {
  tool_call: {
    icon: <Wrench size={14} />,
    color: 'text-blue-400',
    bg: 'bg-blue-500/10 border-blue-500/30',
    label: 'Wrench Call',
  },
  tool_result: {
    icon: <Play size={14} />,
    color: 'text-green-400',
    bg: 'bg-green-500/10 border-green-500/30',
    label: 'Wrench Result',
  },
  skill_injected: {
    icon: <Sparkles size={14} />,
    color: 'text-purple-400',
    bg: 'bg-purple-500/10 border-purple-500/30',
    label: 'Skill Injected',
  },
  hook_triggered: {
    icon: <RotateCcw size={14} />,
    color: 'text-orange-400',
    bg: 'bg-orange-500/10 border-orange-500/30',
    label: 'Hook Triggered',
  },
  text_generation: {
    icon: <MessageSquare size={14} />,
    color: 'text-gray-400',
    bg: 'bg-gray-500/10 border-gray-500/30',
    label: 'Text Generation',
  },
  error: {
    icon: <Terminal size={14} />,
    color: 'text-red-400',
    bg: 'bg-red-500/10 border-red-500/30',
    label: 'Error',
  },
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms === 0) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function truncate(str: string | null, len: number = 200): string | null {
  if (!str) return null
  if (str.length <= len) return str
  return str.slice(0, len) + '...'
}

export default function TracesPage() {
  const { id } = useParams() as { id: string }
  const [traces, setTraces] = useState<TraceEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<string>('')
  const [totalCost, setTotalCost] = useState(0)
  const [totalTokens, setTotalTokens] = useState({ in: 0, out: 0 })

  const load = async () => {
    try {
      const res = await fetch(`/api/conversations/${id}/traces`)
      const data = await res.json()
      const traceList = Array.isArray(data) ? data : []
      setTraces(traceList)

      // Calculate totals
      let cost = 0
      let tokensIn = 0
      let tokensOut = 0
      for (const t of traceList) {
        if (t.costCents !== null) cost += Number(t.costCents)
        if (t.tokensIn !== null) tokensIn += t.tokensIn
        if (t.tokensOut !== null) tokensOut += t.tokensOut
      }
      setTotalCost(cost)
      setTotalTokens({ in: tokensIn, out: tokensOut })
    } catch { /* ignore */ }
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [id])

  const toggleStep = (traceId: string) => {
    setExpandedSteps(prev => {
      const next = new Set(prev)
      if (next.has(traceId)) next.delete(traceId)
      else next.add(traceId)
      return next
    })
  }

  const filtered = traces.filter(t => {
    if (!filter) return true
    return t.type.includes(filter) || (t.toolName && t.toolName.includes(filter))
  })

  const typeCounts: Record<string, number> = {}
  for (const t of traces) {
    typeCounts[t.type] = (typeCounts[t.type] || 0) + 1
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle flex-shrink-0">
        <div className="flex items-center gap-2">
          <Bot size={18} className="text-accent" />
          <h1 className="text-sm font-semibold text-text-primary">Trace Timeline</h1>
          <p className="text-xs text-text-muted ml-2">
            {traces.length} steps
          </p>
        </div>
        <button
          onClick={load}
          className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-raised transition-colors"
          title="Refresh"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 4v6h-6M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
        </button>
      </div>

      {/* Summary Bar */}
      {traces.length > 0 && (
        <div className="flex items-center gap-3 px-4 py-2 border-b border-border-subtle flex-shrink-0 text-[10px]">
          <span className="flex items-center gap-1 text-blue-400">
            <Wrench size={10} />
            {typeCounts.tool_call || 0} tool_calls
          </span>
          <span className="flex items-center gap-1 text-green-400">
            <Play size={10} />
            {typeCounts.tool_result || 0} results
          </span>
          <span className="flex items-center gap-1 text-purple-400">
            <Sparkles size={10} />
            {typeCounts.skill_injected || 0} skills
          </span>
          <span className="flex items-center gap-1 text-orange-400">
            <RotateCcw size={10} />
            {typeCounts.hook_triggered || 0} hooks
          </span>
          <span className="flex items-center gap-1 text-gray-400 ml-auto">
            <Clock size={10} />
            {traces.reduce((sum, t) => sum + (t.durationMs || 0), 0) / 1000 | 0}s total
          </span>
          {totalCost > 0 && (
            <span className="text-text-muted">
              ${totalCost.toFixed(4)} cost
            </span>
          )}
        </div>
      )}

      {/* Filter */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border-subtle flex-shrink-0">
        <select
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="px-2 py-1 text-xs rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent"
        >
          <option value="">All Types</option>
          <option value="tool_call">Wrench Calls</option>
          <option value="tool_result">Wrench Results</option>
          <option value="skill_injected">Skill Injected</option>
          <option value="hook_triggered">Hook Triggered</option>
          <option value="text_generation">Text Generation</option>
          <option value="error">Errors</option>
        </select>

        {Object.keys(typeCounts).length > 1 && (
          <button
            onClick={() => setFilter('')}
            className="px-2 py-1 text-[10px] rounded text-text-muted hover:text-text-primary hover:bg-bg-raised transition-colors"
          >
            Clear Filter
          </button>
        )}
      </div>

      {/* Timeline */}
      <div className="flex-1 overflow-auto px-4 py-3">
        {loading ? (
          <div className="text-center py-8 text-text-muted text-sm">Loading traces...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-8 text-text-muted text-sm">No trace data available for this conversation.</div>
        ) : (
          <div className="space-y-0">
            {filtered.map((trace, idx) => {
              const config = TYPE_CONFIG[trace.type] || TYPE_CONFIG.text_generation
              const isExpanded = expandedSteps.has(trace.id)

              return (
                <div key={trace.id} className="relative">
                  {/* Vertical line connector */}
                  {idx < filtered.length - 1 && (
                    <div className="absolute left-[17px] top-8 bottom-[-1px] w-px bg-border-subtle" />
                  )}

                  <div
                    className={`relative flex gap-3 px-3 py-2.5 rounded-lg border transition-colors cursor-pointer hover:bg-bg-raised ${
                      isExpanded ? 'border-accent/30' : 'border-transparent'
                    }`}
                    onClick={() => toggleStep(trace.id)}
                  >
                    {/* Step number and icon */}
                    <div className="flex flex-col items-center flex-shrink-0">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center border ${config.bg} ${config.color}`}>
                        {config.icon}
                      </div>
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      {/* Header row */}
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-medium text-text-muted w-6">
                          #{trace.step}
                        </span>
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${config.bg} ${config.color}`}>
                          {config.label}
                        </span>
                        {trace.toolName && (
                          <span className="text-xs text-text-primary font-mono truncate">
                            {trace.toolName}
                          </span>
                        )}
                        {trace.skillName && (
                          <span className="text-xs text-purple-400 font-mono">
                            skill:{trace.skillName}
                          </span>
                        )}
                        {trace.hookName && (
                          <span className="text-xs text-orange-400 font-mono">
                            hook:{trace.hookName}
                          </span>
                        )}
                        {trace.modelUsed && (
                          <span className="text-[10px] text-text-muted ml-auto">
                            {trace.modelUsed}
                          </span>
                        )}
                      </div>

                      {/* Metadata */}
                      <div className="flex items-center gap-3 mt-1 text-[10px] text-text-muted">
                        {trace.durationMs !== null && (
                          <span className="flex items-center gap-1">
                            <Clock size={9} />
                            {formatDuration(trace.durationMs)}
                          </span>
                        )}
                        {trace.tokensIn !== null && trace.tokensIn > 0 && (
                          <span>{trace.tokensIn.toLocaleString()} in</span>
                        )}
                        {trace.tokensOut !== null && trace.tokensOut > 0 && (
                          <span>{trace.tokensOut.toLocaleString()} out</span>
                        )}
                        {trace.costCents !== null && trace.costCents > 0 && (
                          <span>${Number(trace.costCents).toFixed(4)}</span>
                        )}
                      </div>

                      {/* Collapsible Detail */}
                      {isExpanded && (
                        <div className="mt-2 space-y-2">
                          {trace.content && (
                            <div className="text-xs text-text-secondary bg-bg-raised rounded p-2 border border-border-subtle max-h-40 overflow-auto">
                              {truncate(trace.content, 500)}
                            </div>
                          )}
                          {trace.toolArgs && (
                            <div>
                              <span className="text-[10px] font-medium text-text-muted">Args:</span>
                              <pre className="text-[10px] text-text-secondary bg-bg-raised rounded p-2 border border-border-subtle mt-0.5 overflow-auto whitespace-pre-wrap max-h-40 font-mono">
                                {truncate(trace.toolArgs, 800)}
                              </pre>
                            </div>
                          )}
                          {trace.toolResult && (
                            <div>
                              <span className="text-[10px] font-medium text-text-muted">Result:</span>
                              <pre className="text-[10px] text-text-secondary bg-bg-raised rounded p-2 border border-border-subtle mt-0.5 overflow-auto whitespace-pre-wrap max-h-40 font-mono">
                                {truncate(trace.toolResult, 800)}
                              </pre>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Expand indicator */}
                    <div className="flex-shrink-0 mt-1 text-text-muted">
                      {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
