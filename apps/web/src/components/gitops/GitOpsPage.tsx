'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import {
  RefreshCw, ExternalLink, CheckCircle, Server, Container,
  GitBranch, Rocket, X, AlertCircle, Copy, Check, Bot,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { KpiCard } from '@/components/dashboard/KpiCard'
import { ClusterPreflightFlow } from '@/components/environments/ClusterPreflightFlow'

// ─── Types ────────────────────────────────────────────────────────────────────

interface EnvironmentRef {
  id: string
  name: string
  type: string
  gitOwner: string | null
  gitRepo: string | null
}

interface GitOpsPR {
  id: string
  prNumber: number
  title: string
  operation: string
  decision: 'auto' | 'review'
  status: 'open' | 'merged' | 'closed'
  prUrl: string
  branch: string
  reasoning: string | null
  createdAt: string
  mergedAt: string | null
  environmentId: string
  environment: EnvironmentRef
}

interface ArgoCDApp {
  name: string
  syncStatus: string
  healthStatus: string
  revision: string
  message: string
  reconciledAt: string | null
}

interface ArgoCDState {
  applications: ArgoCDApp[]
  reportedAt: string
  overallHealth: string
}

interface Environment {
  id: string
  name: string
  type: string
  status: string | null
  gitOwner: string | null
  gitRepo: string | null
  argoCdUrl: string | null
  kubeconfig: string | null
  gitOpsPRs?: GitOpsPR[]
  metadata?: {
    argocd?: ArgoCDState
  } | null
}

interface BootstrapEvent {
  type: 'step' | 'log' | 'error' | 'done'
  message: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function isToday(iso: string | null): boolean {
  if (!iso) return false
  const d = new Date(iso)
  const now = new Date()
  return d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
}

// ─── Bootstrap Modal ─────────────────────────────────────────────────────────

function BootstrapModal({
  envId,
  envName,
  envType,
  hasKubeconfig,
  onClose,
}: {
  envId: string
  envName: string
  envType: string
  hasKubeconfig: boolean
  onClose: () => void
}) {
  const isLocalhost = envType === 'localhost'
  const isRemoteDocker = envType === 'docker'
  const isCluster = !isLocalhost && !isRemoteDocker

  // Shared: SSE log lines for localhost auto-deploy and cluster bootstrap
  const [lines, setLines] = useState<BootstrapEvent[]>([])
  const [done, setDone] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const [kubeconfigReady, setKubeconfigReady] = useState(!isCluster || hasKubeconfig)

  // Remote docker only: copy-paste command
  const [dockerCmd, setDockerCmd] = useState<string | null>(null)
  const [dockerLoading, setDockerLoading] = useState(false)
  const [dockerError, setDockerError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Scroll to bottom as lines arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines])

  // Remote docker: generate the copy-paste command on mount
  useEffect(() => {
    if (!isRemoteDocker) return
    setDockerLoading(true)
    fetch(`/api/environments/${envId}/generate-join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gatewayType: 'docker' }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error)
        setDockerCmd(d.dockerCmd)
      })
      .catch(err => setDockerError(err.message))
      .finally(() => setDockerLoading(false))
  }, [envId, isRemoteDocker])

  const copyDockerCmd = () => {
    if (!dockerCmd) return
    navigator.clipboard.writeText(dockerCmd).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }


  // SSE stream helper — shared by localhost deploy and cluster bootstrap
  const streamEndpoint = (url: string) => {
    let cancelled = false
    setStreaming(true)
    setLines([])

    fetch(url, { method: 'POST' })
      .then(async (res) => {
        if (!res.body) throw new Error('No response body')
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { value, done: readerDone } = await reader.read()
          if (readerDone || cancelled) break
          buffer += decoder.decode(value, { stream: true })
          const parts = buffer.split('\n\n')
          buffer = parts.pop() ?? ''
          for (const part of parts) {
            const line = part.trim()
            if (!line.startsWith('data:')) continue
            try {
              const event: BootstrapEvent = JSON.parse(line.slice(5).trim())
              setLines(prev => [...prev, event])
              if (event.type === 'done' || event.type === 'error') {
                setDone(true)
                setStreaming(false)
              }
            } catch { /* ignore */ }
          }
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setLines(prev => [...prev, { type: 'error', message: err.message }])
          setDone(true)
          setStreaming(false)
        }
      })

    return () => { cancelled = true }
  }

  // Localhost: auto-deploy on mount
  useEffect(() => {
    if (!isLocalhost) return
    return streamEndpoint(`/api/environments/${envId}/deploy-gateway`)
  }, [envId, isLocalhost])

  // Cluster: start bootstrap once kubeconfig is ready
  useEffect(() => {
    if (!isCluster || !kubeconfigReady) return
    return streamEndpoint(`/api/environments/${envId}/bootstrap`)
  }, [envId, isCluster, kubeconfigReady])

  const router = useRouter()
  const [creatingTask, setCreatingTask] = useState(false)

  const askAgentToDeploy = async () => {
    setCreatingTask(true)
    try {
      // Create a task for tracking
      const taskTitle = isCluster
        ? `Bootstrap ${envName}: deploy ArgoCD + ORION gateway`
        : `Deploy ORION gateway to ${envName}`
      await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: taskTitle,
          description: `Deploy the ORION gateway to the ${envName} environment (type: ${envType}, ID: ${envId}).`,
          priority: 'high',
        }),
      })

      if (isLocalhost) {
        // Localhost: the deployment is fully automated via the Docker socket.
        // Just run it directly — no kubectl, no AI needed.
        setCreatingTask(false)
        return streamEndpoint(`/api/environments/${envId}/deploy-gateway`)
      }

      // Remote docker / cluster: fetch the editable prompt from DB, then open chat
      const promptKey = isRemoteDocker ? 'bootstrap.docker' : 'bootstrap.cluster'
      const templateRes = await fetch(`/api/admin/prompts/${encodeURIComponent(promptKey)}`)
      let context: string
      if (templateRes.ok) {
        const { content } = await templateRes.json() as { content: string }
        context = content
          .replace(/\{\{envId\}\}/g, envId)
          .replace(/\{\{envName\}\}/g, envName)
      } else {
        context = `Deploy the ORION gateway to **${envName}** (type: \`${envType}\`, ID: \`${envId}\`).`
      }

      const convoRes = await fetch('/api/chat/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initialContext: context }),
      })
      const convo = await convoRes.json()
      onClose()
      router.push(`/chat?conversationId=${convo.id}`)
    } catch {
      setCreatingTask(false)
    }
  }

  // Shared log panel — inset from modal walls with visible padding
  const LogPanel = () => (
    <div className="flex-1 overflow-y-auto px-4 py-3">
      <div className="bg-black rounded-lg border border-border-subtle p-4 space-y-1 font-mono text-xs min-h-[180px]">
        {lines.length === 0 && <p className="text-text-muted">Starting…</p>}
        {lines.map((evt, i) => (
          <div
            key={i}
            className={
              evt.type === 'step'  ? 'text-text-primary font-bold' :
              evt.type === 'error' ? 'text-status-error' :
              evt.type === 'done'  ? 'text-status-healthy font-semibold' :
              'text-text-muted'
            }
          >
            {evt.type === 'step' && '› '}
            {evt.type === 'error' && '✗ '}
            {evt.type === 'done'  && '✓ '}
            {evt.message}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )

  const headerTitle =
    isLocalhost    ? `Deploying Gateway — ${envName}` :
    isRemoteDocker ? `Deploy Gateway — ${envName}` :
                     `Bootstrapping — ${envName}`

  const canClose = isRemoteDocker || done || !kubeconfigReady

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gradient-to-br from-black/70 via-black/50 to-bg-sidebar/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl bg-bg-card border border-border-subtle rounded-xl shadow-2xl flex flex-col max-h-[80vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <div className="flex items-center gap-2">
            <Rocket size={16} className="text-accent" />
            <span className="text-sm font-semibold text-text-primary">{headerTitle}</span>
            {streaming && <RefreshCw size={13} className="animate-spin text-text-muted ml-1" />}
          </div>
          <div className="flex items-center gap-2">
            {/* Ask Agent button — always available */}
            {!streaming && (
              <button
                onClick={askAgentToDeploy}
                disabled={creatingTask}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-border-subtle bg-bg-raised text-text-secondary hover:text-accent hover:border-accent/40 transition-colors disabled:opacity-40"
                title="Ask an AI agent to handle this"
              >
                <Bot size={13} />
                {creatingTask ? 'Opening…' : 'Ask Agent'}
              </button>
            )}
            {canClose && (
              <button onClick={onClose} className="p-1.5 rounded hover:bg-bg-raised text-text-muted hover:text-text-primary transition-colors">
                <X size={16} />
              </button>
            )}
          </div>
        </div>

        {/* ── Remote Docker: copy-paste command ── */}
        {isRemoteDocker && (
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            <p className="text-sm text-text-secondary">
              Run this on <span className="text-text-primary font-medium">{envName}</span>. The gateway will connect back to ORION automatically.
            </p>
            {dockerLoading && (
              <div className="flex items-center gap-2 text-text-muted text-sm">
                <RefreshCw size={13} className="animate-spin" /> Generating command…
              </div>
            )}
            {dockerError && <p className="text-sm text-status-error">{dockerError}</p>}
            {dockerCmd && (
              <>
                <div className="relative">
                  <pre className="text-xs font-mono bg-black border border-border-subtle text-green-400 rounded-lg p-4 overflow-x-auto whitespace-pre-wrap break-all">{dockerCmd}</pre>
                  <button
                    onClick={copyDockerCmd}
                    className="absolute top-2 right-2 p-1.5 rounded bg-bg-raised border border-border-subtle text-text-muted hover:text-text-primary transition-colors"
                    title="Copy"
                  >
                    {copied ? <Check size={13} className="text-status-healthy" /> : <Copy size={13} />}
                  </button>
                </div>
                <p className="text-xs text-text-muted">Gateway appears connected in ORION within ~30 seconds.</p>
              </>
            )}
          </div>
        )}

        {/* ── Localhost: auto-deploy log ── */}
        {isLocalhost && <LogPanel />}

        {/* ── Cluster: preflight → auto-detect credentials → bootstrap log ── */}
        {isCluster && !kubeconfigReady && (
          <div className="flex-1 overflow-y-auto px-4 py-3">
            <ClusterPreflightFlow
              envId={envId}
              onReady={() => setKubeconfigReady(true)}
            />
          </div>
        )}
        {isCluster && kubeconfigReady && <LogPanel />}

        {/* Footer — cluster bootstrap done */}
        {isCluster && done && (
          <div className="px-5 py-3 border-t border-border-subtle flex justify-end">
            <button onClick={onClose} className="px-4 py-2 text-sm rounded bg-accent text-white hover:bg-accent/80 transition-colors">
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── PR Table (shared by open + closed tabs) ──────────────────────────────────

function PRTable({ prs, showStatus }: { prs: GitOpsPR[]; showStatus?: boolean }) {
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
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-bg-raised border border-border-subtle text-text-muted font-mono">
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
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-border-subtle bg-bg-raised text-text-secondary hover:text-text-primary hover:border-accent transition-colors"
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

const HEALTH_COLORS: Record<string, string> = {
  Healthy:     'text-status-healthy',
  Progressing: 'text-status-warning',
  Degraded:    'text-status-error',
  Suspended:   'text-text-muted',
  Missing:     'text-status-error',
  Unknown:     'text-text-muted',
}

const SYNC_COLORS: Record<string, string> = {
  Synced:    'text-status-healthy',
  OutOfSync: 'text-status-warning',
  Unknown:   'text-text-muted',
}

function ArgoCDSyncPanel({ argocd }: { argocd: ArgoCDState }) {
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
          <span className={`flex-shrink-0 ${SYNC_COLORS[app.syncStatus] ?? 'text-text-muted'}`}>
            {app.syncStatus}
          </span>
          <span className={`flex-shrink-0 ${HEALTH_COLORS[app.healthStatus] ?? 'text-text-muted'}`}>
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

function EnvironmentCard({
  env,
  openPrCount,
  selected,
  onSelect,
  onBootstrap,
}: {
  env: Environment
  openPrCount: number
  selected: boolean
  onSelect: (id: string) => void
  onBootstrap: (id: string, name: string, envType: string, hasKubeconfig: boolean) => void
}) {
  const hasRepo = !!(env.gitOwner && env.gitRepo)

  const statusDot =
    env.status === 'connected' ? 'bg-status-healthy' :
    env.status === 'error'     ? 'bg-status-error'    :
    'bg-text-muted'

  return (
    <div
      onClick={() => onSelect(env.id)}
      className={`bg-bg-surface border rounded-xl p-4 flex flex-col gap-3 cursor-pointer transition-colors ${
        selected
          ? 'border-accent ring-1 ring-accent/30'
          : 'border-border-subtle hover:border-accent/40'
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {env.type === 'docker'
            ? <Container size={16} className="text-text-muted flex-shrink-0" />
            : <Server size={16} className="text-text-muted flex-shrink-0" />
          }
          <span className="text-sm font-semibold text-text-primary truncate">{env.name}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Status dot */}
          <span className="flex items-center gap-1.5 text-xs text-text-muted">
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDot}`} />
            {env.status ?? 'unknown'}
          </span>
        </div>
      </div>

      {/* Gitea repo */}
      <div className="flex items-center gap-1.5 text-xs text-text-muted">
        <GitBranch size={12} className="flex-shrink-0" />
        {hasRepo ? (
          <span className="font-mono">{env.gitOwner}/{env.gitRepo}</span>
        ) : (
          <span className="italic text-text-muted/60">No repo configured</span>
        )}
      </div>

      {/* ArgoCD sync state */}
      {env.metadata?.argocd && (
        <ArgoCDSyncPanel argocd={env.metadata.argocd} />
      )}

      {/* Footer row: PR count + links */}
      <div className="flex items-center justify-between gap-2 pt-1">
        <div className="flex items-center gap-2">
          {/* Open PR badge */}
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${
            openPrCount > 0
              ? 'bg-status-warning/15 text-status-warning'
              : 'bg-bg-raised text-text-muted border border-border-subtle'
          }`}>
            {openPrCount} open PR{openPrCount !== 1 ? 's' : ''}
          </span>

          {/* ArgoCD link */}
          {env.argoCdUrl && (
            <a
              href={env.argoCdUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
            >
              <ExternalLink size={10} />
              ArgoCD
            </a>
          )}
        </div>

        {/* Bootstrap button */}
        {!hasRepo && (
          <button
            onClick={() => onBootstrap(env.id, env.name, env.type, !!env.kubeconfig)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-accent/10 text-accent border border-accent/30 hover:bg-accent/20 transition-colors font-medium"
          >
            <Rocket size={12} />
            Bootstrap
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function GitOpsPage() {
  const [prs, setPrs] = useState<GitOpsPR[]>([])
  const [environments, setEnvironments] = useState<Environment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [bootstrapTarget, setBootstrapTarget] = useState<{ id: string; name: string; envType: string; hasKubeconfig: boolean } | null>(null)
  const [prTab, setPrTab] = useState<'open' | 'closed'>('open')
  const [selectedEnvId, setSelectedEnvId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [prsRes, envsRes] = await Promise.all([
        fetch('/api/gitops/prs'),
        fetch('/api/environments'),
      ])
      if (!prsRes.ok || !envsRes.ok) throw new Error('Failed to fetch data')
      const [prsData, envsData] = await Promise.all([prsRes.json(), envsRes.json()])
      setPrs(prsData)
      setEnvironments(envsData)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Derived counts
  const filteredPRs = selectedEnvId ? prs.filter(p => p.environmentId === selectedEnvId) : prs
  const openPRs = filteredPRs.filter(p => p.status === 'open')
  const closedPRs = filteredPRs.filter(p => p.status === 'merged' || p.status === 'closed')
  const awaitingReview = prs.filter(p => p.status === 'open' && p.decision === 'review').length
  const autoMergedToday = prs.filter(p => p.status === 'merged' && isToday(p.mergedAt)).length

  // Per-environment open PR counts (always unfiltered for badges)
  const openByEnv: Record<string, number> = {}
  for (const pr of prs.filter(p => p.status === 'open')) {
    openByEnv[pr.environmentId] = (openByEnv[pr.environmentId] ?? 0) + 1
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-text-primary">GitOps</h1>
          <p className="text-sm text-text-muted mt-0.5">AI-proposed changes and PR status</p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-2 px-3 py-2 text-sm rounded border border-border-subtle bg-bg-raised text-text-secondary hover:text-text-primary hover:border-accent transition-colors disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg border border-status-error/40 bg-status-error/10 text-status-error text-sm">
          <AlertCircle size={15} />
          {error}
        </div>
      )}

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Awaiting Review"    value={awaitingReview}       color="warning" />
        <KpiCard label="Auto-Merged Today"  value={autoMergedToday}      color="healthy" />
        <KpiCard label="Total Environments" value={environments.length}   color="info"    />
        <KpiCard label="Open PRs"           value={openPRs.length}       color="info"    />
      </div>

      {/* PR tabs */}
      <div className="bg-bg-surface border border-border-subtle rounded-xl overflow-hidden">
        {/* Tab bar */}
        <div className="flex items-center justify-between border-b border-border-subtle px-2 pt-1">
        <div className="flex items-center">
          <button
            onClick={() => setPrTab('open')}
            className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors ${
              prTab === 'open'
                ? 'border-accent text-text-primary'
                : 'border-transparent text-text-muted hover:text-text-secondary'
            }`}
          >
            Open
            {openPRs.length > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] bg-status-warning/20 text-status-warning">
                {openPRs.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setPrTab('closed')}
            className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors ${
              prTab === 'closed'
                ? 'border-accent text-text-primary'
                : 'border-transparent text-text-muted hover:text-text-secondary'
            }`}
          >
            Closed
            {closedPRs.length > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] bg-bg-raised text-text-muted border border-border-subtle">
                {closedPRs.length}
              </span>
            )}
          </button>
        </div>
          {selectedEnvId && (
            <span className="text-xs text-text-muted pr-2 pb-1">
              {environments.find(e => e.id === selectedEnvId)?.name}
            </span>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12 gap-2 text-text-muted text-sm">
            <RefreshCw size={14} className="animate-spin" />
            Loading…
          </div>
        ) : prTab === 'open' ? (
          <PRTable prs={openPRs} />
        ) : (
          <PRTable prs={closedPRs} showStatus />
        )}
      </div>

      {/* Environments grid */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-text-primary">Environments</h2>
          {selectedEnvId && (
            <button
              onClick={() => setSelectedEnvId(null)}
              className="inline-flex items-center gap-1 text-xs text-accent hover:text-text-primary transition-colors"
            >
              <X size={12} />
              Clear filter
            </button>
          )}
        </div>
        {loading ? (
          <div className="flex items-center gap-2 text-text-muted text-sm">
            <RefreshCw size={14} className="animate-spin" />
            Loading…
          </div>
        ) : environments.length === 0 ? (
          <p className="text-sm text-text-muted">No environments configured.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {environments.map(env => (
              <EnvironmentCard
                key={env.id}
                env={env}
                openPrCount={openByEnv[env.id] ?? 0}
                selected={selectedEnvId === env.id}
                onSelect={id => setSelectedEnvId(prev => prev === id ? null : id)}
                onBootstrap={(id, name, envType, hasKubeconfig) => setBootstrapTarget({ id, name, envType, hasKubeconfig })}
              />
            ))}
          </div>
        )}
      </div>

      {/* Bootstrap modal */}
      {bootstrapTarget && (
        <BootstrapModal
          envId={bootstrapTarget.id}
          envName={bootstrapTarget.name}
          envType={bootstrapTarget.envType}
          hasKubeconfig={bootstrapTarget.hasKubeconfig}
          onClose={() => { setBootstrapTarget(null); load() }}
        />
      )}
    </div>
  )
}
