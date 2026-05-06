'use client'
import { useState, useEffect, useRef } from 'react'
import { CheckCircle, XCircle, AlertCircle, RefreshCw, LogIn, ClipboardPaste } from 'lucide-react'

interface CredStatus {
  configured: boolean
  valid: boolean
  expiresAt: string | null
  reason: string | null
}

interface Job {
  id: string
  status: string
  logs: string
}

export default function ClaudeOAuthPage() {
  const [status, setStatus] = useState<CredStatus | null>(null)
  const [tab, setTab] = useState<'oauth' | 'paste'>('oauth')
  const [pasteValue, setPasteValue] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)
  const [pasteSaving, setPasteSaving] = useState(false)
  const [pasteSaved, setPasteSaved] = useState(false)
  const [job, setJob] = useState<Job | null>(null)
  const [starting, setStarting] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)

  const loadStatus = () =>
    fetch('/api/admin/claude/status')
      .then(r => r.json())
      .then(setStatus)
      .catch(() => {})

  useEffect(() => { loadStatus() }, [])

  // Poll job logs while running
  useEffect(() => {
    if (!job || job.status === 'completed' || job.status === 'failed') return
    const t = setInterval(() => {
      fetch(`/api/jobs/${job.id}`)
        .then(r => r.json())
        .then((j: Job) => {
          setJob(j)
          if (j.status === 'completed') { loadStatus(); clearInterval(t) }
        })
        .catch(() => {})
    }, 1500)
    return () => clearInterval(t)
  }, [job])

  // Auto-scroll logs
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [job?.logs])

  const startOAuth = async () => {
    setStarting(true)
    setJob(null)
    const res = await fetch('/api/admin/claude/oauth', { method: 'POST' })
    const data = await res.json()
    setJob({ id: data.jobId, status: 'running', logs: '' })
    setStarting(false)
  }

  const savePaste = async () => {
    setPasteError(null)
    setPasteSaving(true)
    const res = await fetch('/api/admin/claude/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credentials: pasteValue }),
    })
    const data = await res.json()
    if (res.ok) {
      setPasteSaved(true)
      setPasteValue('')
      setTimeout(() => setPasteSaved(false), 3000)
      loadStatus()
    } else {
      setPasteError(data.error ?? 'Failed to save')
    }
    setPasteSaving(false)
  }

  // Extract any URL from logs for display
  const authUrl = job?.logs?.match(/https:\/\/[^\s]+/)?.[0]

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div>
        <h1 className="text-lg font-semibold text-text-primary">Claude Code OAuth</h1>
        <p className="text-sm text-text-muted mt-0.5">
          Authenticate Claude Code so agents can use it as a runner for tasks and conversations.
        </p>
      </div>

      {/* Status card */}
      <div className="rounded-lg border border-border-subtle bg-bg-card p-4">
        <div className="flex items-center gap-3">
          {!status ? (
            <RefreshCw size={16} className="text-text-muted animate-spin" />
          ) : status.valid ? (
            <CheckCircle size={16} className="text-status-healthy" />
          ) : status.configured ? (
            <AlertCircle size={16} className="text-status-warning" />
          ) : (
            <XCircle size={16} className="text-status-error" />
          )}
          <div>
            <p className="text-sm font-medium text-text-primary">
              {!status ? 'Checking...' : status.valid ? 'Connected' : status.configured ? 'Token expired' : 'Not configured'}
            </p>
            {status?.expiresAt && (
              <p className="text-xs text-text-muted mt-0.5">
                Expires {new Date(status.expiresAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}
              </p>
            )}
            {status?.reason && !status.valid && (
              <p className="text-xs text-text-muted mt-0.5">{status.reason}</p>
            )}
          </div>
          <button
            onClick={loadStatus}
            className="ml-auto text-text-muted hover:text-text-primary transition-colors"
            title="Refresh status"
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border-subtle">
        {(['oauth', 'paste'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t
                ? 'border-accent text-accent'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            {t === 'oauth' ? (
              <span className="flex items-center gap-1.5"><LogIn size={13} />OAuth Flow</span>
            ) : (
              <span className="flex items-center gap-1.5"><ClipboardPaste size={13} />Paste Credentials</span>
            )}
          </button>
        ))}
      </div>

      {tab === 'oauth' && (
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            Runs <code className="text-xs bg-bg-raised px-1 py-0.5 rounded">claude login</code> inside the{' '}
            <code className="text-xs bg-bg-raised px-1 py-0.5 rounded">claude-refresh</code> container.
            A browser auth URL will appear below — open it, log in, and credentials will be saved automatically.
          </p>

          <button
            onClick={startOAuth}
            disabled={starting || job?.status === 'running'}
            className="flex items-center gap-2 px-4 py-2 rounded bg-accent text-white text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-50"
          >
            {starting || job?.status === 'running' ? (
              <><RefreshCw size={13} className="animate-spin" />Running...</>
            ) : (
              <><LogIn size={13} />Start OAuth Flow</>
            )}
          </button>

          {job && (
            <div className="rounded-lg border border-border-subtle overflow-hidden">
              <div className="px-3 py-2 border-b border-border-subtle bg-bg-raised flex items-center justify-between">
                <span className="text-xs font-mono text-text-muted">Output</span>
                <span className={`text-xs font-medium ${
                  job.status === 'completed' ? 'text-status-healthy' :
                  job.status === 'failed'    ? 'text-status-error' :
                  'text-status-warning'
                }`}>{job.status}</span>
              </div>
              <pre
                ref={logRef}
                className="p-3 text-xs font-mono text-text-secondary whitespace-pre-wrap max-h-64 overflow-y-auto bg-bg-page"
              >{job.logs || '…'}</pre>
            </div>
          )}

          {authUrl && job?.status === 'running' && (
            <div className="rounded-lg border border-accent/30 bg-accent/5 p-4">
              <p className="text-sm font-medium text-text-primary mb-2">Open this URL to authenticate:</p>
              <a
                href={authUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-accent underline break-all"
              >
                {authUrl}
              </a>
            </div>
          )}
        </div>
      )}

      {tab === 'paste' && (
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            Run <code className="text-xs bg-bg-raised px-1 py-0.5 rounded">claude login</code> on any
            machine, then paste the contents of{' '}
            <code className="text-xs bg-bg-raised px-1 py-0.5 rounded">~/.claude/.credentials.json</code> below.
          </p>

          <textarea
            value={pasteValue}
            onChange={e => setPasteValue(e.target.value)}
            placeholder={'{\n  "claudeAiOauth": {\n    "accessToken": "...",\n    "expiresAt": 1234567890\n  }\n}'}
            rows={10}
            className="w-full px-3 py-2 text-xs font-mono bg-bg-raised border border-border-subtle rounded text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors resize-none"
          />

          {pasteError && (
            <p className="text-sm text-status-error">{pasteError}</p>
          )}

          <div className="flex items-center gap-3">
            <button
              onClick={savePaste}
              disabled={!pasteValue.trim() || pasteSaving}
              className="flex items-center gap-2 px-4 py-2 rounded bg-accent text-white text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              {pasteSaving ? <RefreshCw size={13} className="animate-spin" /> : <ClipboardPaste size={13} />}
              {pasteSaving ? 'Saving...' : 'Save Credentials'}
            </button>
            {pasteSaved && <span className="text-sm text-status-healthy">Saved successfully</span>}
          </div>
        </div>
      )}
    </div>
  )
}
