'use client'
import { useState, useEffect, useRef } from 'react'
import { CheckCircle, XCircle, AlertCircle, RefreshCw, LogIn, ClipboardPaste, Send, X } from 'lucide-react'

interface CredStatus {
  authenticated: boolean
  valid: boolean
  expiresAt: string | null
  reason: string | null
}

interface PollData {
  status: 'idle' | 'starting' | 'waiting' | 'completing' | 'done' | 'error'
  authUrl: string | null
  output: string
  creds?: CredStatus
}

export default function ClaudeOAuthPage() {
  const [status, setStatus]       = useState<CredStatus | null>(null)
  const [tab, setTab]             = useState<'oauth' | 'paste'>('oauth')
  const [poll, setPoll]           = useState<PollData | null>(null)
  const [code, setCode]           = useState('')
  const [starting, setStarting]   = useState(false)
  const [sending, setSending]     = useState(false)
  const [pasteVal, setPasteVal]   = useState('')
  const [pasteErr, setPasteErr]   = useState<string | null>(null)
  const [pasteBusy, setPasteBusy] = useState(false)
  const [pasteDone, setPasteDone] = useState(false)
  const [svcErr, setSvcErr]       = useState<string | null>(null)
  const logRef = useRef<HTMLPreElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadStatus = async () => {
    const res = await fetch('/api/admin/claude/status').catch(() => null)
    if (res?.ok) setStatus(await res.json())
  }

  useEffect(() => { loadStatus() }, [])

  // Auto-scroll logs
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [poll?.output])

  // Poll while login is in progress
  useEffect(() => {
    if (!poll || poll.status === 'done' || poll.status === 'error' || poll.status === 'idle') {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      if (poll?.status === 'done') loadStatus()
      return
    }
    if (pollRef.current) return
    pollRef.current = setInterval(async () => {
      const res = await fetch('/api/admin/claude/oauth?action=poll').catch(() => null)
      if (res?.ok) {
        const data: PollData = await res.json()
        setPoll(data)
      }
    }, 1500)
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  }, [poll?.status])

  const startLogin = async () => {
    setStarting(true)
    setSvcErr(null)
    setPoll(null)
    setCode('')
    const res = await fetch('/api/admin/claude/oauth?action=login', { method: 'POST' }).catch(() => null)
    if (!res || !res.ok) {
      setSvcErr('Claude Code service is not reachable. Make sure orion-claude is running.')
      setStarting(false)
      return
    }
    const data: PollData = await res.json()
    setPoll(data)
    setStarting(false)
  }

  const submitCode = async () => {
    if (!code.trim()) return
    setSending(true)
    const res = await fetch('/api/admin/claude/oauth?action=code', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ code: code.trim() }),
    }).catch(() => null)
    if (res?.ok) {
      const data: PollData = await res.json()
      setPoll(prev => prev ? { ...prev, ...data } : data)
    }
    setSending(false)
  }

  const cancelLogin = async () => {
    await fetch('/api/admin/claude/oauth?action=cancel', { method: 'POST' }).catch(() => {})
    setPoll(null)
    setCode('')
  }

  const savePaste = async () => {
    setPasteErr(null)
    setPasteBusy(true)
    const res = await fetch('/api/admin/claude/credentials', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ credentials: pasteVal }),
    }).catch(() => null)
    if (!res || !res.ok) {
      const d = await res?.json().catch(() => ({}))
      setPasteErr(d?.error ?? 'Failed to save')
    } else {
      setPasteDone(true)
      setPasteVal('')
      setTimeout(() => setPasteDone(false), 3000)
      loadStatus()
    }
    setPasteBusy(false)
  }

  const isRunning = poll && poll.status !== 'done' && poll.status !== 'error' && poll.status !== 'idle'

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div>
        <h1 className="text-lg font-semibold text-text-primary">Claude Code</h1>
        <p className="text-sm text-text-muted mt-0.5">
          Authenticate the Claude Code service so agents can use it as a task runner.
        </p>
      </div>

      {/* Status */}
      <div className="rounded-lg border border-border-subtle bg-bg-card p-4 flex items-center gap-3">
        {!status ? (
          <RefreshCw size={16} className="text-text-muted animate-spin" />
        ) : status.valid ? (
          <CheckCircle size={16} className="text-status-healthy flex-shrink-0" />
        ) : status.authenticated ? (
          <AlertCircle size={16} className="text-status-warning flex-shrink-0" />
        ) : (
          <XCircle size={16} className="text-status-error flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-text-primary">
            {!status ? 'Checking...'
              : status.valid ? 'Connected'
              : status.authenticated ? 'Token expired'
              : 'Not authenticated'}
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
        <button onClick={loadStatus} className="text-text-muted hover:text-text-primary transition-colors">
          <RefreshCw size={13} />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border-subtle">
        {(['oauth', 'paste'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            {t === 'oauth'
              ? <span className="flex items-center gap-1.5"><LogIn size={13} />OAuth Flow</span>
              : <span className="flex items-center gap-1.5"><ClipboardPaste size={13} />Paste Credentials</span>}
          </button>
        ))}
      </div>

      {/* OAuth tab */}
      {tab === 'oauth' && (
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            Starts <code className="text-xs bg-bg-raised px-1 py-0.5 rounded">claude login</code> inside
            the <code className="text-xs bg-bg-raised px-1 py-0.5 rounded">orion-claude</code> service.
            Visit the URL that appears, then paste the authorization code back here.
          </p>

          {svcErr && (
            <div className="rounded border border-status-error/40 bg-status-error/10 px-4 py-3 text-sm text-status-error">
              {svcErr}
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={startLogin}
              disabled={starting || !!isRunning}
              className="flex items-center gap-2 px-4 py-2 rounded bg-accent text-white text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              {starting ? <RefreshCw size={13} className="animate-spin" /> : <LogIn size={13} />}
              {starting ? 'Starting...' : isRunning ? 'Login in progress...' : 'Start Login'}
            </button>
            {isRunning && (
              <button
                onClick={cancelLogin}
                className="flex items-center gap-2 px-3 py-2 rounded border border-border-subtle text-sm text-text-secondary hover:text-text-primary transition-colors"
              >
                <X size={13} /> Cancel
              </button>
            )}
          </div>

          {/* Log output */}
          {poll && (
            <div className="rounded-lg border border-border-subtle overflow-hidden">
              <div className="px-3 py-2 border-b border-border-subtle bg-bg-raised flex items-center justify-between">
                <span className="text-xs font-mono text-text-muted">claude login output</span>
                <span className={`text-xs font-medium ${
                  poll.status === 'done'      ? 'text-status-healthy' :
                  poll.status === 'error'     ? 'text-status-error' :
                  poll.status === 'waiting'   ? 'text-status-warning' :
                  'text-text-muted'
                }`}>{poll.status}</span>
              </div>
              <pre
                ref={logRef}
                className="p-3 text-xs font-mono text-text-secondary whitespace-pre-wrap max-h-48 overflow-y-auto bg-bg-page"
              >{poll.output || 'Starting…'}</pre>
            </div>
          )}

          {/* Auth URL callout */}
          {poll?.authUrl && poll.status !== 'done' && (
            <div className="rounded-lg border border-accent/30 bg-accent/5 p-4 space-y-2">
              <p className="text-sm font-medium text-text-primary">1. Open this URL in your browser:</p>
              <a
                href={poll.authUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-sm text-accent underline break-all font-mono"
              >
                {poll.authUrl}
              </a>
              <p className="text-sm text-text-secondary pt-1">
                2. Authorize, then paste the code you receive below:
              </p>
            </div>
          )}

          {/* Code input — shown once we have the URL */}
          {poll?.authUrl && poll.status !== 'done' && poll.status !== 'error' && (
            <div className="flex gap-2">
              <input
                value={code}
                onChange={e => setCode(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !sending && submitCode()}
                placeholder="Paste authorization code here…"
                className="flex-1 px-3 py-2 text-sm bg-bg-raised border border-border-subtle rounded text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors font-mono"
              />
              <button
                onClick={submitCode}
                disabled={!code.trim() || sending}
                className="flex items-center gap-2 px-4 py-2 rounded bg-accent text-white text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-50"
              >
                {sending ? <RefreshCw size={13} className="animate-spin" /> : <Send size={13} />}
                Submit
              </button>
            </div>
          )}

          {poll?.status === 'done' && (
            <div className="rounded-lg border border-status-healthy/30 bg-status-healthy/5 px-4 py-3 flex items-center gap-2">
              <CheckCircle size={14} className="text-status-healthy flex-shrink-0" />
              <p className="text-sm text-status-healthy">Authentication complete. Claude Code is ready.</p>
            </div>
          )}
        </div>
      )}

      {/* Paste tab */}
      {tab === 'paste' && (
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            Run <code className="text-xs bg-bg-raised px-1 py-0.5 rounded">claude login</code> on any
            machine with Claude Code installed, then paste the contents of{' '}
            <code className="text-xs bg-bg-raised px-1 py-0.5 rounded">~/.claude/.credentials.json</code>.
          </p>
          <textarea
            value={pasteVal}
            onChange={e => setPasteVal(e.target.value)}
            placeholder={'{\n  "claudeAiOauth": {\n    "accessToken": "...",\n    "expiresAt": 1234567890\n  }\n}'}
            rows={10}
            className="w-full px-3 py-2 text-xs font-mono bg-bg-raised border border-border-subtle rounded text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors resize-none"
          />
          {pasteErr && <p className="text-sm text-status-error">{pasteErr}</p>}
          <div className="flex items-center gap-3">
            <button
              onClick={savePaste}
              disabled={!pasteVal.trim() || pasteBusy}
              className="flex items-center gap-2 px-4 py-2 rounded bg-accent text-white text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              {pasteBusy ? <RefreshCw size={13} className="animate-spin" /> : <ClipboardPaste size={13} />}
              {pasteBusy ? 'Saving...' : 'Save Credentials'}
            </button>
            {pasteDone && <span className="text-sm text-status-healthy">Saved successfully</span>}
          </div>
        </div>
      )}
    </div>
  )
}
