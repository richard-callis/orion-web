'use client'
import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import {
  BarChart3, Play, RefreshCw, TrendingUp, Star, Shield, Target,
  Zap, CheckCircle, AlertCircle,
} from 'lucide-react'

interface ScoreEntry {
  targetType: string
  targetId: string
  scoreTotal: number
  accuracy: number
  completeness: number
  safety: number
  efficiency: number
  quality: number
  evalCount: number
}

interface AggregateData {
  labels: string[]
  scores: number[]
  count: number[]
  totalEvals: number
  overallAvg: number
  windowDays: number
  targetType: string
}

type Window = 7 | 30 | 90
type EvalType = 'conversation' | 'task' | 'skill' | 'hook'

export default function EvalsPage() {
  const { id } = useParams() as { id: string }
  const [scores, setScores] = useState<ScoreEntry[]>([])
  const [aggregate, setAggregate] = useState<AggregateData | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [window, setWindow] = useState<Window>(30)
  const [evalType, setEvalType] = useState<EvalType>('conversation')
  const [runMessage, setRunMessage] = useState('')
  const [error, setError] = useState<string | null>(null)

  const loadScores = async () => {
    try {
      const res = await fetch(`/api/environments/${id}/evals/scores`)
      const data = await res.json()
      setScores(Array.isArray(data) ? data : [])
    } catch { /* ignore */ }
  }

  const loadAggregate = async () => {
    try {
      const res = await fetch(
        `/api/environments/${id}/evals/aggregate?type=${evalType}&window=${window}`
      )
      const data = await res.json()
      setAggregate(data)
    } catch { /* ignore */ }
  }

  const loadAll = async () => {
    setError(null)
    setLoading(true)
    await Promise.all([loadScores(), loadAggregate()])
    setLoading(false)
  }

  useEffect(() => {
    loadAll()
  }, [id])

  // Reload aggregate when filters change
  useEffect(() => {
    loadAggregate()
  }, [id, window, evalType])

  const handleRunEval = async (targetType: 'conversation' | 'task' | 'skill' | 'hook', targetId: string) => {
    setRunning(true)
    setRunMessage('')
    setError(null)
    try {
      const res = await fetch(`/api/environments/${id}/evals/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetType, targetId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Eval failed')
      setRunMessage(`Eval completed: ${data.evalsCreated} eval(s) created`)
      loadAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setRunning(false)
    }
  }

  // Compute summary stats
  const avgScore = scores.length > 0
    ? scores.reduce((sum, s) => sum + s.scoreTotal, 0) / scores.length
    : 0
  const avgAccuracy = scores.length > 0
    ? scores.reduce((sum, s) => sum + s.accuracy, 0) / scores.length
    : 0
  const avgSafety = scores.length > 0
    ? scores.reduce((sum, s) => sum + s.safety, 0) / scores.length
    : 0
  const totalEvals = scores.reduce((sum, s) => sum + s.evalCount, 0)

  const getScoreColor = (score: number) => {
    if (score >= 80) return 'text-green-400'
    if (score >= 50) return 'text-yellow-400'
    return 'text-red-400'
  }

  const getScoreBg = (score: number) => {
    if (score >= 80) return 'bg-green-500/10 border-green-500/30'
    if (score >= 50) return 'bg-yellow-500/10 border-yellow-500/30'
    return 'bg-red-500/10 border-red-500/30'
  }

  // Build simple CSS bar chart data
  const maxScore = aggregate ? Math.max(...aggregate.scores, 1) : 1

  return (
    <div className="flex flex-col h-full overflow-auto">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle flex-shrink-0">
        <div className="flex items-center gap-2">
          <BarChart3 size={18} className="text-accent" />
          <h1 className="text-sm font-semibold text-text-primary">Eval Dashboard</h1>
          <p className="text-xs text-text-muted ml-2">
            {scores.length} targets &middot; {totalEvals} evals
          </p>
        </div>
        <button
          onClick={loadAll}
          className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-raised transition-colors"
          title="Refresh"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Summary Cards */}
        {loading ? (
          <div className="text-center py-8 text-text-muted text-sm">Loading eval data...</div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className={`rounded-lg border ${getScoreBg(avgScore)} p-3`}>
                <div className={`text-2xl font-bold ${getScoreColor(avgScore)}`}>
                  {avgScore.toFixed(1)}%
                </div>
                <div className="text-[10px] text-text-muted mt-1">Avg Score</div>
              </div>
              <div className="rounded-lg border border-border-subtle bg-bg-surface p-3">
                <div className={`text-2xl font-bold ${getScoreColor(avgAccuracy)}`}>
                  {avgAccuracy.toFixed(1)}%
                </div>
                <div className="text-[10px] text-text-muted mt-1 flex items-center gap-1">
                  <Target size={10} /> Accuracy
                </div>
              </div>
              <div className="rounded-lg border border-border-subtle bg-bg-surface p-3">
                <div className={`text-2xl font-bold ${getScoreColor(avgSafety)}`}>
                  {avgSafety.toFixed(1)}%
                </div>
                <div className="text-[10px] text-text-muted mt-1 flex items-center gap-1">
                  <Shield size={10} /> Safety
                </div>
              </div>
              <div className="rounded-lg border border-border-subtle bg-bg-surface p-3">
                <div className="text-2xl font-bold text-text-primary">
                  {totalEvals}
                </div>
                <div className="text-[10px] text-text-muted mt-1 flex items-center gap-1">
                  <CheckCircle size={10} /> Total Evals
                </div>
              </div>
            </div>

            {/* Score Breakdown Row */}
            {scores.length > 0 && (
              <div className="rounded-lg border border-border-subtle bg-bg-surface p-4">
                <h3 className="text-xs font-medium text-text-primary mb-3 flex items-center gap-1.5">
                  <TrendingUp size={13} className="text-accent" />
                  Score Breakdown
                </h3>
                <div className="space-y-2">
                  {scores.slice(0, 5).map(s => (
                    <div key={s.targetId} className="flex items-center gap-3">
                      <div className="w-32 text-[10px] font-mono text-text-primary truncate" title={s.targetId}>
                        {s.targetType}:{s.targetId.slice(0, 8)}
                      </div>
                      {/* Score bars */}
                      <div className="flex-1 flex items-center gap-2">
                        <div className="flex-1 bg-bg-raised rounded-full h-2 overflow-hidden">
                          <div
                            className={`h-full rounded-full ${
                              s.accuracy >= 80 ? 'bg-green-500' : s.accuracy >= 50 ? 'bg-yellow-500' : 'bg-red-500'
                            }`}
                            style={{ width: `${s.accuracy}%` }}
                          />
                        </div>
                        <span className={`text-[10px] text-text-muted w-10 text-right`}>
                          {s.accuracy}%
                        </span>
                      </div>
                      <span className={`text-[10px] w-12 text-right ${getScoreColor(s.scoreTotal)}`}>
                        {s.scoreTotal.toFixed(0)}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Aggregate Chart (CSS Bar Chart) */}
            {aggregate && aggregate.labels.length > 0 && (
              <div className="rounded-lg border border-border-subtle bg-bg-surface p-4">
                <h3 className="text-xs font-medium text-text-primary mb-1 flex items-center gap-1.5">
                  <BarChart3 size={13} className="text-accent" />
                  Avg Score Over Time
                </h3>
                <p className="text-[10px] text-text-muted mb-3">
                  Type: {aggregate.targetType} &middot; Window: {aggregate.windowDays} days &middot; Overall Avg: {aggregate.overallAvg.toFixed(1)}% &middot; {aggregate.totalEvals} evals
                </p>
                <div className="flex items-end gap-1 h-32">
                  {aggregate.labels.map((label, i) => {
                    const height = aggregate.scores[i] ? (aggregate.scores[i] / maxScore) * 100 : 0
                    const isHigh = (aggregate.scores[i] || 0) >= 80
                    const isMid = (aggregate.scores[i] || 0) >= 50 && (aggregate.scores[i] || 0) < 80

                    return (
                      <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
                        <span className="text-[9px] text-text-muted">
                          {aggregate.scores[i] !== null ? aggregate.scores[i].toFixed(0) : '--'}
                        </span>
                        <div
                          className={`w-full rounded-t-sm transition-all ${
                            isHigh ? 'bg-green-500/60' : isMid ? 'bg-yellow-500/60' : 'bg-red-500/60'
                          }`}
                          style={{ height: `${Math.max(height, 2)}%` }}
                          title={`${label}: ${aggregate.scores[i]?.toFixed(1)}% (${aggregate.count[i]} evals)`}
                        />
                        <span className="text-[8px] text-text-muted whitespace-nowrap rotate-0">
                          {label}
                        </span>
                      </div>
                    )
                  })}
                </div>

                {/* Legend */}
                <div className="flex items-center gap-3 mt-2 text-[10px] text-text-muted">
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-green-500/60" />
                    &ge;80% Healthy
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-yellow-500/60" />
                    50-80% Warning
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-red-500/60" />
                    &lt;50% Critical
                  </span>
                </div>
              </div>
            )}

            {/* Run Eval Section */}
            <div className="rounded-lg border border-border-subtle bg-bg-surface p-4">
              <h3 className="text-xs font-medium text-text-primary mb-3 flex items-center gap-1.5">
                <Play size={13} className="text-accent" />
                Run Manual Eval
              </h3>

              {/* Run All Quick Button */}
              <div className="mb-3">
                <button
                  onClick={() => handleRunEval(evalType, '')}
                  disabled={running}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-accent/15 text-accent hover:bg-accent/25 transition-colors disabled:opacity-50"
                >
                  <Zap size={12} />
                  {running ? 'Running...' : 'Run Eval'}
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {scores.slice(0, 10).map(s => (
                  <div key={s.targetId} className="flex items-center justify-between px-3 py-2 border border-border-subtle rounded-lg">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono text-text-primary truncate max-w-[120px]" title={`${s.targetType}:${s.targetId}`}>
                        {s.targetType}:{s.targetId.slice(0, 8)}
                      </span>
                      <span className={`text-[10px] ${getScoreColor(s.scoreTotal)}`}>
                        {s.scoreTotal.toFixed(0)}%
                      </span>
                    </div>
                    <button
                      onClick={() => handleRunEval(s.targetType as 'conversation' | 'task' | 'skill' | 'hook', s.targetId)}
                      disabled={running}
                      className="px-2 py-1 rounded text-[10px] bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
                    >
                      Re-eval
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Filter Controls */}
            <div className="flex items-center gap-3 flex-wrap">
              <div>
                <label className="text-[10px] text-text-muted mr-2">Type:</label>
                <select
                  value={evalType}
                  onChange={e => setEvalType(e.target.value as EvalType)}
                  className="px-2 py-1 text-xs rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent"
                >
                  <option value="conversation">Conversations</option>
                  <option value="task">Tasks</option>
                  <option value="skill">Skills</option>
                  <option value="hook">Hooks</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] text-text-muted mr-2">Window:</label>
                <select
                  value={window}
                  onChange={e => setWindow(parseInt(e.target.value, 10) as Window)}
                  className="px-2 py-1 text-xs rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent"
                >
                  <option value={7}>7 Days</option>
                  <option value={30}>30 Days</option>
                  <option value={90}>90 Days</option>
                </select>
              </div>
              {runMessage && (
                <span className="text-xs text-green-400 flex items-center gap-1">
                  <CheckCircle size={12} />
                  {runMessage}
                </span>
              )}
              {error && (
                <span className="text-xs text-red-400 flex items-center gap-1">
                  <AlertCircle size={12} />
                  {error}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
