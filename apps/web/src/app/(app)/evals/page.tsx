'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Play, FlaskConical, ChevronRight } from 'lucide-react'

interface EvalSuite {
  id: string
  name: string
  description: string | null
  agentId: string | null
  agent: { id: string; name: string } | null
  _count: { cases: number }
  runs: Array<{ scoreTotal: number | null; status: string; createdAt: string }>
  createdAt: string
  updatedAt: string
}

interface EvalRun {
  id: string
  suiteId: string
  agentId: string
  modelId: string
  status: string
  scoreTotal: number | null
  passCount: number
  failCount: number
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  suite: { id: string; name: string }
  agent: { id: string; name: string }
}

interface Agent {
  id: string
  name: string
}

export default function EvalsPage() {
  const router = useRouter()
  const [tab, setTab] = useState<'suites' | 'runs'>('suites')
  const [suites, setSuites] = useState<EvalSuite[]>([])
  const [runs, setRuns] = useState<EvalRun[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [showNewSuite, setShowNewSuite] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newAgentId, setNewAgentId] = useState('')
  const [creating, setCreating] = useState(false)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [sRes, aRes] = await Promise.all([
        fetch('/api/eval-suites'),
        fetch('/api/agents'),
      ])
      if (sRes.ok) setSuites(await sRes.json())
      if (aRes.ok) setAgents(await aRes.json())

      // Load recent runs across all suites
      const suitesData: EvalSuite[] = sRes.ok ? await sRes.clone().json().catch(() => []) : []
      const runPromises = suitesData.slice(0, 10).map((s: EvalSuite) =>
        fetch(`/api/eval-suites/${s.id}/runs`).then(r => r.ok ? r.json() : [])
      )
      const allRunArrays = await Promise.all(runPromises)
      const allRuns = allRunArrays.flat().sort(
        (a: EvalRun, b: EvalRun) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )
      setRuns(allRuns.slice(0, 50))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  async function createSuite() {
    if (!newName.trim()) return
    setCreating(true)
    try {
      const res = await fetch('/api/eval-suites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), description: newDesc || undefined, agentId: newAgentId || undefined }),
      })
      if (res.ok) {
        setShowNewSuite(false)
        setNewName('')
        setNewDesc('')
        setNewAgentId('')
        await loadData()
      }
    } finally {
      setCreating(false)
    }
  }

  function scoreColor(score: number | null | undefined) {
    if (score === null || score === undefined) return 'text-text-muted'
    if (score >= 80) return 'text-green-400'
    if (score >= 50) return 'text-yellow-400'
    return 'text-red-400'
  }

  function statusBadge(status: string) {
    const colors: Record<string, string> = {
      completed: 'bg-green-500/20 text-green-400',
      running: 'bg-blue-500/20 text-blue-400',
      pending: 'bg-yellow-500/20 text-yellow-400',
      failed: 'bg-red-500/20 text-red-400',
    }
    return `inline-flex px-2 py-0.5 rounded text-xs font-medium ${colors[status] ?? 'bg-bg-raised text-text-muted'}`
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <FlaskConical size={22} className="text-accent" />
          <h1 className="text-xl font-semibold text-text-primary">Agent Evals</h1>
        </div>
        <button
          onClick={() => setShowNewSuite(true)}
          className="flex items-center gap-2 px-3 py-1.5 bg-accent text-white rounded text-sm hover:bg-accent/80 transition-colors"
        >
          <Plus size={15} />
          New Suite
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-border-subtle">
        {(['suites', 'runs'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize transition-colors -mb-px border-b-2 ${
              tab === t
                ? 'border-accent text-accent'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* New Suite Form */}
      {showNewSuite && (
        <div className="mb-6 p-4 bg-bg-card border border-border-subtle rounded-lg">
          <h2 className="text-sm font-medium text-text-primary mb-3">Create Eval Suite</h2>
          <div className="space-y-3">
            <input
              className="w-full px-3 py-2 bg-bg-raised border border-border-subtle rounded text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
              placeholder="Suite name *"
              value={newName}
              onChange={e => setNewName(e.target.value)}
            />
            <input
              className="w-full px-3 py-2 bg-bg-raised border border-border-subtle rounded text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
              placeholder="Description (optional)"
              value={newDesc}
              onChange={e => setNewDesc(e.target.value)}
            />
            <select
              className="w-full px-3 py-2 bg-bg-raised border border-border-subtle rounded text-sm text-text-primary focus:outline-none focus:border-accent"
              value={newAgentId}
              onChange={e => setNewAgentId(e.target.value)}
            >
              <option value="">No default agent</option>
              {agents.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-2 mt-3">
            <button
              onClick={createSuite}
              disabled={creating || !newName.trim()}
              className="px-3 py-1.5 bg-accent text-white rounded text-sm hover:bg-accent/80 disabled:opacity-50 transition-colors"
            >
              {creating ? 'Creating...' : 'Create Suite'}
            </button>
            <button
              onClick={() => setShowNewSuite(false)}
              className="px-3 py-1.5 bg-bg-raised text-text-secondary rounded text-sm hover:bg-bg-hover transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-text-muted text-sm">Loading...</div>
      ) : tab === 'suites' ? (
        <div className="space-y-2">
          {suites.length === 0 ? (
            <div className="text-center py-12 text-text-muted text-sm">
              No eval suites yet. Create one to get started.
            </div>
          ) : (
            suites.map(suite => {
              const latestRun = suite.runs[0]
              return (
                <div
                  key={suite.id}
                  className="flex items-center justify-between p-4 bg-bg-card border border-border-subtle rounded-lg hover:border-border-hover transition-colors cursor-pointer"
                  onClick={() => router.push(`/evals/${suite.id}`)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-text-primary">{suite.name}</span>
                      <span className="text-xs text-text-muted bg-bg-raised px-2 py-0.5 rounded">
                        {suite._count.cases} case{suite._count.cases !== 1 ? 's' : ''}
                      </span>
                      {suite.agent && (
                        <span className="text-xs text-text-muted">
                          Agent: {suite.agent.name}
                        </span>
                      )}
                    </div>
                    {suite.description && (
                      <p className="text-xs text-text-muted mt-0.5 truncate">{suite.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-4 ml-4">
                    {latestRun && (
                      <div className="text-right">
                        <div className={`text-sm font-medium ${scoreColor(latestRun.scoreTotal)}`}>
                          {latestRun.scoreTotal !== null ? `${latestRun.scoreTotal.toFixed(1)}%` : '--'}
                        </div>
                        <div className={statusBadge(latestRun.status)}>{latestRun.status}</div>
                      </div>
                    )}
                    <ChevronRight size={16} className="text-text-muted" />
                  </div>
                </div>
              )
            })
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {runs.length === 0 ? (
            <div className="text-center py-12 text-text-muted text-sm">No runs yet.</div>
          ) : (
            runs.map(run => (
              <div key={run.id} className="flex items-center justify-between p-4 bg-bg-card border border-border-subtle rounded-lg">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-text-primary">{run.suite?.name ?? run.suiteId}</span>
                    <span className={statusBadge(run.status)}>{run.status}</span>
                  </div>
                  <div className="text-xs text-text-muted mt-0.5">
                    Agent: {run.agent?.name ?? run.agentId} &middot; Model: {run.modelId} &middot; {new Date(run.createdAt).toLocaleString()}
                  </div>
                </div>
                <div className="ml-4 text-right">
                  {run.scoreTotal !== null ? (
                    <div className={`text-sm font-medium ${scoreColor(run.scoreTotal)}`}>
                      {run.scoreTotal.toFixed(1)}%
                    </div>
                  ) : null}
                  <div className="text-xs text-text-muted">
                    {run.passCount} pass / {run.failCount} fail
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
