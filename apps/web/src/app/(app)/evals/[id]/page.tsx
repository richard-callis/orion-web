'use client'
import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, Play, Plus, Trash2, FlaskConical } from 'lucide-react'

interface AssertionDef {
  type: 'contains_text' | 'not_contains_text' | 'regex_match' | 'llm_judge'
  value: string
  weight?: number
}

interface EvalCase {
  id: string
  suiteId: string
  title: string
  prompt: string
  expectedOutput: string | null
  assertions: string // JSON
  weight: number
  createdAt: string
}

interface EvalRun {
  id: string
  agentId: string
  modelId: string
  status: string
  scoreTotal: number | null
  passCount: number
  failCount: number
  createdAt: string
  agent: { id: string; name: string }
}

interface EvalSuite {
  id: string
  name: string
  description: string | null
  agentId: string | null
  agent: { id: string; name: string } | null
  cases: EvalCase[]
  runs: EvalRun[]
}

interface Agent {
  id: string
  name: string
}

const ASSERTION_TYPE_COLORS: Record<string, string> = {
  contains_text: 'bg-blue-500/20 text-blue-400',
  not_contains_text: 'bg-orange-500/20 text-orange-400',
  regex_match: 'bg-purple-500/20 text-purple-400',
  llm_judge: 'bg-green-500/20 text-green-400',
}

export default function EvalSuiteDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const [suite, setSuite] = useState<EvalSuite | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [runAgentId, setRunAgentId] = useState('')
  const [showRunForm, setShowRunForm] = useState(false)
  const [showNewCase, setShowNewCase] = useState(false)
  const [newCase, setNewCase] = useState({
    title: '',
    prompt: '',
    expectedOutput: '',
    assertionType: 'contains_text' as AssertionDef['type'],
    assertionValue: '',
  })
  const [addingCase, setAddingCase] = useState(false)

  const loadSuite = useCallback(async () => {
    setLoading(true)
    try {
      const [sRes, aRes] = await Promise.all([
        fetch(`/api/eval-suites/${params.id}`),
        fetch('/api/agents'),
      ])
      if (sRes.ok) setSuite(await sRes.json())
      if (aRes.ok) setAgents(await aRes.json())
    } finally {
      setLoading(false)
    }
  }, [params.id])

  useEffect(() => {
    void loadSuite()
  }, [loadSuite])

  async function triggerRun() {
    if (!runAgentId) return
    setRunning(true)
    try {
      const res = await fetch(`/api/eval-suites/${params.id}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: runAgentId }),
      })
      if (res.ok) {
        setShowRunForm(false)
        await loadSuite()
      }
    } finally {
      setRunning(false)
    }
  }

  async function addCase() {
    if (!newCase.title || !newCase.prompt || !newCase.assertionValue) return
    setAddingCase(true)
    try {
      const assertions: AssertionDef[] = [
        { type: newCase.assertionType, value: newCase.assertionValue },
      ]
      const res = await fetch(`/api/eval-suites/${params.id}/cases`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: newCase.title,
          prompt: newCase.prompt,
          expectedOutput: newCase.expectedOutput || undefined,
          assertions,
        }),
      })
      if (res.ok) {
        setShowNewCase(false)
        setNewCase({ title: '', prompt: '', expectedOutput: '', assertionType: 'contains_text', assertionValue: '' })
        await loadSuite()
      }
    } finally {
      setAddingCase(false)
    }
  }

  async function deleteCase(caseId: string) {
    if (!confirm('Delete this case?')) return
    await fetch(`/api/eval-suites/${params.id}/cases/${caseId}`, { method: 'DELETE' })
    await loadSuite()
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

  if (loading) return <div className="p-6 text-text-muted text-sm">Loading...</div>
  if (!suite) return <div className="p-6 text-text-muted text-sm">Suite not found.</div>

  const defaultAgentId = runAgentId || suite.agentId || (agents[0]?.id ?? '')

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={() => router.push('/evals')}
          className="text-text-muted hover:text-text-primary transition-colors"
        >
          <ArrowLeft size={18} />
        </button>
        <FlaskConical size={20} className="text-accent" />
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-text-primary">{suite.name}</h1>
          {suite.description && (
            <p className="text-sm text-text-muted mt-0.5">{suite.description}</p>
          )}
        </div>
        <button
          onClick={() => setShowRunForm(true)}
          className="flex items-center gap-2 px-3 py-1.5 bg-accent text-white rounded text-sm hover:bg-accent/80 transition-colors"
        >
          <Play size={14} />
          Run Benchmark
        </button>
      </div>

      {/* Run form */}
      {showRunForm && (
        <div className="mb-6 p-4 bg-bg-card border border-border-subtle rounded-lg">
          <h2 className="text-sm font-medium text-text-primary mb-3">Run Benchmark</h2>
          <select
            className="w-full px-3 py-2 bg-bg-raised border border-border-subtle rounded text-sm text-text-primary focus:outline-none focus:border-accent mb-3"
            value={runAgentId || defaultAgentId}
            onChange={e => setRunAgentId(e.target.value)}
          >
            <option value="">Select agent</option>
            {agents.map(a => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <div className="flex gap-2">
            <button
              onClick={triggerRun}
              disabled={running || !(runAgentId || defaultAgentId)}
              className="px-3 py-1.5 bg-accent text-white rounded text-sm hover:bg-accent/80 disabled:opacity-50 transition-colors"
            >
              {running ? 'Starting...' : 'Start Run'}
            </button>
            <button
              onClick={() => setShowRunForm(false)}
              className="px-3 py-1.5 bg-bg-raised text-text-secondary rounded text-sm hover:bg-bg-hover transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Cases */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wide">
            Test Cases ({suite.cases.length})
          </h2>
          <button
            onClick={() => setShowNewCase(true)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-bg-raised text-text-secondary border border-border-subtle rounded hover:bg-bg-hover transition-colors"
          >
            <Plus size={13} />
            Add Case
          </button>
        </div>

        {showNewCase && (
          <div className="mb-3 p-4 bg-bg-card border border-accent/30 rounded-lg">
            <h3 className="text-sm font-medium text-text-primary mb-3">New Test Case</h3>
            <div className="space-y-2">
              <input
                className="w-full px-3 py-2 bg-bg-raised border border-border-subtle rounded text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
                placeholder="Case title *"
                value={newCase.title}
                onChange={e => setNewCase(v => ({ ...v, title: e.target.value }))}
              />
              <textarea
                className="w-full px-3 py-2 bg-bg-raised border border-border-subtle rounded text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-accent resize-none"
                placeholder="Prompt to send to agent *"
                rows={3}
                value={newCase.prompt}
                onChange={e => setNewCase(v => ({ ...v, prompt: e.target.value }))}
              />
              <textarea
                className="w-full px-3 py-2 bg-bg-raised border border-border-subtle rounded text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-accent resize-none"
                placeholder="Expected output (optional, used by llm_judge)"
                rows={2}
                value={newCase.expectedOutput}
                onChange={e => setNewCase(v => ({ ...v, expectedOutput: e.target.value }))}
              />
              <div className="flex gap-2">
                <select
                  className="px-3 py-2 bg-bg-raised border border-border-subtle rounded text-sm text-text-primary focus:outline-none focus:border-accent"
                  value={newCase.assertionType}
                  onChange={e => setNewCase(v => ({ ...v, assertionType: e.target.value as AssertionDef['type'] }))}
                >
                  <option value="contains_text">contains_text</option>
                  <option value="not_contains_text">not_contains_text</option>
                  <option value="regex_match">regex_match</option>
                  <option value="llm_judge">llm_judge</option>
                </select>
                <input
                  className="flex-1 px-3 py-2 bg-bg-raised border border-border-subtle rounded text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
                  placeholder="Assertion value *"
                  value={newCase.assertionValue}
                  onChange={e => setNewCase(v => ({ ...v, assertionValue: e.target.value }))}
                />
              </div>
            </div>
            <div className="flex gap-2 mt-3">
              <button
                onClick={addCase}
                disabled={addingCase || !newCase.title || !newCase.prompt || !newCase.assertionValue}
                className="px-3 py-1.5 bg-accent text-white rounded text-sm hover:bg-accent/80 disabled:opacity-50 transition-colors"
              >
                {addingCase ? 'Adding...' : 'Add Case'}
              </button>
              <button
                onClick={() => setShowNewCase(false)}
                className="px-3 py-1.5 bg-bg-raised text-text-secondary rounded text-sm hover:bg-bg-hover transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {suite.cases.length === 0 ? (
            <div className="text-center py-8 text-text-muted text-sm border border-dashed border-border-subtle rounded-lg">
              No test cases yet. Add a case to get started.
            </div>
          ) : (
            suite.cases.map(c => {
              let assertions: AssertionDef[] = []
              try { assertions = JSON.parse(c.assertions) } catch { /* empty */ }
              return (
                <div key={c.id} className="p-3 bg-bg-card border border-border-subtle rounded-lg group">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm text-text-primary">{c.title}</div>
                      <div className="text-xs text-text-muted mt-1 line-clamp-2">{c.prompt}</div>
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {assertions.map((a, i) => (
                          <span
                            key={i}
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${ASSERTION_TYPE_COLORS[a.type] ?? 'bg-bg-raised text-text-muted'}`}
                          >
                            {a.type}
                            <span className="opacity-70 max-w-[120px] truncate">{a.value}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                    <button
                      onClick={() => deleteCase(c.id)}
                      className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-red-400 transition-all"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </section>

      {/* Run History */}
      <section>
        <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wide mb-3">
          Run History
        </h2>
        {suite.runs.length === 0 ? (
          <div className="text-center py-8 text-text-muted text-sm border border-dashed border-border-subtle rounded-lg">
            No runs yet. Click &quot;Run Benchmark&quot; to start.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-xs text-text-muted uppercase tracking-wide">
                <th className="text-left py-2 pr-4">Date</th>
                <th className="text-left py-2 pr-4">Agent</th>
                <th className="text-left py-2 pr-4">Status</th>
                <th className="text-right py-2 pr-4">Score</th>
                <th className="text-right py-2">Pass / Fail</th>
              </tr>
            </thead>
            <tbody>
              {suite.runs.map(run => (
                <tr key={run.id} className="border-b border-border-subtle/50 hover:bg-bg-raised/50 transition-colors">
                  <td className="py-2 pr-4 text-text-muted text-xs">
                    {new Date(run.createdAt).toLocaleString()}
                  </td>
                  <td className="py-2 pr-4 text-text-secondary">{run.agent?.name ?? run.agentId}</td>
                  <td className="py-2 pr-4">
                    <span className={statusBadge(run.status)}>{run.status}</span>
                  </td>
                  <td className={`py-2 pr-4 text-right font-medium ${scoreColor(run.scoreTotal)}`}>
                    {run.scoreTotal !== null ? `${run.scoreTotal.toFixed(1)}%` : '--'}
                  </td>
                  <td className="py-2 text-right text-text-muted">
                    <span className="text-green-400">{run.passCount}</span>
                    {' / '}
                    <span className="text-red-400">{run.failCount}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
