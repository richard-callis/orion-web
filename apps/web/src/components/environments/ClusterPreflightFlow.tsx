'use client'

/**
 * ClusterPreflightFlow
 *
 * Shared component used by both the GitOps bootstrap modal and the
 * Environments bootstrap modal.
 *
 * Connects to /api/environments/:id/preflight via SSE, which:
 *   - Probes the node IP to detect cluster flavor (Talos vs K3s)
 *   - Auto-fetches + stores the kubeconfig when credentials allow
 *   - Streams log lines and check results live
 *   - Emits a `done` event when finished
 *
 * Renders:
 *   - A live scrolling log panel during preflight
 *   - A checklist of preflight results as they arrive
 *   - An inline credential input (nodeIp / talosconfig / kubeconfig)
 *     when the preflight says something is missing
 *   - Calls onReady() once canBootstrap === true
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { RefreshCw, Check, Terminal } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { apiFetch, errorMessage, readSSE, parseSSEData } from '@/lib/api'

// ── Types ──────────────────────────────────────────────────────────────────────

type CheckStatus      = 'ok' | 'missing' | 'error' | 'skipped'
type CredentialNeeded = 'nodeIp' | 'talosconfig' | 'kubeconfig'

export interface PreflightCheck {
  id:     string
  label:  string
  status: CheckStatus
  detail: string
}

export interface PreflightResult {
  canBootstrap:      boolean
  checks:            PreflightCheck[]
  gitOwner:          string
  gitRepo:           string
  clusterFlavor?:    string
  credentialNeeded?: CredentialNeeded
}

interface Props {
  envId:    string
  /** Called once preflight passes — parent can start the bootstrap stream */
  onReady:  () => void
}

// ── Component ──────────────────────────────────────────────────────────────────

export function ClusterPreflightFlow({ envId, onReady }: Props) {
  const [checks, setChecks]                     = useState<PreflightCheck[]>([])
  const [logs, setLogs]                         = useState<string[]>([])
  const [result, setResult]                     = useState<PreflightResult | null>(null)
  const [loading, setLoading]                   = useState(false)
  const [inlineNodeIp, setInlineNodeIp]         = useState('')
  const [inlineTalosconfig, setInlineTalosconfig] = useState('')
  const [inlineKubeconfig, setInlineKubeconfig] = useState('')
  const [credSaving, setCredSaving]             = useState(false)
  const [credError, setCredError]               = useState<string | null>(null)
  const logRef                                  = useRef<HTMLDivElement>(null)
  const abortRef                                = useRef<AbortController | null>(null)
  // Parents pass an inline onReady; reading it through a ref keeps runPreflight
  // stable — before, every parent re-render aborted and restarted the preflight.
  const onReadyRef                              = useRef(onReady)
  onReadyRef.current = onReady

  // Auto-scroll the log box itself (scrollIntoView also scrolled the page)
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  const runPreflight = useCallback(async () => {
    // Cancel any in-flight SSE stream
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    setLoading(true)
    setChecks([])
    setLogs([])
    setResult(null)

    try {
      const res = await fetch(`/api/environments/${envId}/preflight`, {
        signal: ctrl.signal,
      })

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => 'Unknown error')
        setResult({
          canBootstrap: false,
          checks: [{ id: 'err', label: 'Error', status: 'error', detail: text }],
          gitOwner: '', gitRepo: '',
        })
        return
      }

      for await (const raw of readSSE(res.body, ctrl.signal)) {
        const evt = parseSSEData<Record<string, unknown>>(raw)
        if (!evt) continue

        if (evt.type === 'log') {
          setLogs(prev => [...prev, evt.message as string])
        } else if (evt.type === 'check') {
          const check = evt.check as PreflightCheck
          setChecks(prev => {
            const idx = prev.findIndex(c => c.id === check.id)
            if (idx >= 0) {
              const next = [...prev]
              next[idx] = check
              return next
            }
            return [...prev, check]
          })
        } else if (evt.type === 'done') {
          const { type: _t, ...rest } = evt as unknown as PreflightResult & { type: string }
          const final = rest as PreflightResult
          setResult(final)
          if (final.canBootstrap) onReadyRef.current()
        } else if (evt.type === 'error') {
          setResult({
            canBootstrap: false,
            checks: [{ id: 'err', label: 'Error', status: 'error', detail: evt.message as string }],
            gitOwner: '', gitRepo: '',
          })
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setResult({
        canBootstrap: false,
        checks: [{ id: 'err', label: 'Error', status: 'error', detail: err instanceof Error ? err.message : String(err) }],
        gitOwner: '', gitRepo: '',
      })
    } finally {
      setLoading(false)
    }
  }, [envId])

  // Run on mount
  useEffect(() => {
    runPreflight()
    return () => { abortRef.current?.abort() }
  }, [runPreflight])

  const saveCredentialAndRecheck = async () => {
    setCredSaving(true)
    setCredError(null)
    try {
      const body: Record<string, string> = {}
      if (inlineNodeIp.trim())
        body.nodeIp      = inlineNodeIp.trim()
      if (inlineTalosconfig.trim())
        body.talosconfig = btoa(unescape(encodeURIComponent(inlineTalosconfig.trim())))
      if (inlineKubeconfig.trim())
        body.kubeconfig  = btoa(unescape(encodeURIComponent(inlineKubeconfig.trim())))

      await apiFetch(`/api/environments/${envId}/credentials`, { method: 'PATCH', body })
      setInlineNodeIp('')
      setInlineTalosconfig('')
      setInlineKubeconfig('')
      await runPreflight()
    } catch (e) {
      // Keep what was typed and don't re-check with credentials that weren't saved
      setCredError(`Could not save credentials: ${errorMessage(e)}`)
    } finally {
      setCredSaving(false)
    }
  }

  const hasInput = inlineNodeIp.trim() || inlineTalosconfig.trim() || inlineKubeconfig.trim()
  const credentialNeeded = result?.credentialNeeded

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-3">

      {/* ── Live log panel ─────────────────────────────────────────────────── */}
      {(loading || logs.length > 0) && (
        <div className="rounded-sm border border-border-subtle bg-bg-raised overflow-hidden">
          <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border-subtle bg-bg-canvas">
            <Terminal size={10} className="text-text-muted" />
            <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider">Bootstrap log</span>
            {loading && <RefreshCw size={9} className="animate-spin text-text-muted ml-auto" />}
          </div>
          <div ref={logRef} role="log" aria-live="polite" className="max-h-40 overflow-y-auto p-2 font-mono text-[10px] text-text-muted space-y-0.5">
            {logs.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap leading-relaxed">{line}</div>
            ))}
            {loading && logs.length === 0 && (
              <div className="text-text-muted italic">Checking cluster state…</div>
            )}
          </div>
        </div>
      )}

      {/* ── Checklist ──────────────────────────────────────────────────────── */}
      {checks.length > 0 && (
        <div className="space-y-2">
          {checks.map(c => (
            <div key={c.id} className="flex items-start gap-3 text-xs">
              <span className={`mt-0.5 shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold ${
                c.status === 'ok'      ? 'bg-status-healthy/20 text-status-healthy' :
                c.status === 'missing' ? 'bg-amber-500/20 text-amber-400' :
                c.status === 'error'   ? 'bg-status-error/20 text-status-error' :
                                         'bg-bg-raised text-text-muted'
              }`}>
                {c.status === 'ok' ? '✓' : c.status === 'missing' ? '○' : c.status === 'error' ? '✗' : '–'}
              </span>
              <div className="flex-1 min-w-0">
                <span className="font-medium text-text-primary">{c.label}</span>
                <span className="ml-2 text-text-muted">{c.detail}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Inline credential input ─────────────────────────────────────────── */}
      {credentialNeeded && (
        <div className="rounded-sm border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
          {credentialNeeded === 'nodeIp' && (
            <>
              <label htmlFor={`${envId}-nodeip`} className="block text-xs font-medium text-amber-400">Control plane node IP required</label>
              <Input
                id={`${envId}-nodeip`}
                value={inlineNodeIp}
                onChange={e => setInlineNodeIp(e.target.value)}
                placeholder="10.2.2.100"
                className="text-xs"
              />
            </>
          )}
          {credentialNeeded === 'talosconfig' && (
            <>
              <p className="text-xs font-medium text-amber-400">
                Talos cluster detected — paste your <code className="font-mono">talosconfig</code>
              </p>
              <p className="text-[10px] text-text-muted">
                Run <code className="font-mono bg-bg-raised px-1 rounded-sm">talosctl config view</code> or find it at{' '}
                <code className="font-mono bg-bg-raised px-1 rounded-sm">~/.talos/config</code>.
              </p>
              <Textarea
                aria-label="talosconfig"
                value={inlineTalosconfig}
                onChange={e => setInlineTalosconfig(e.target.value)}
                placeholder={'context: homelab\ncontexts:\n  homelab:\n    endpoints:\n      - ...'}
                rows={5}
                className="font-mono text-[11px] resize-y leading-normal"
              />
            </>
          )}
          {credentialNeeded === 'kubeconfig' && (
            <>
              <p className="text-xs font-medium text-amber-400">Kubeconfig required</p>
              <p className="text-[10px] text-text-muted">
                Auto-fetch failed for this cluster type. Paste the kubeconfig below.
              </p>
              <Textarea
                aria-label="kubeconfig"
                value={inlineKubeconfig}
                onChange={e => setInlineKubeconfig(e.target.value)}
                placeholder={'apiVersion: v1\nkind: Config\nclusters:\n  ...'}
                rows={5}
                className="font-mono text-[11px] resize-y leading-normal"
              />
            </>
          )}
          {credError && <p role="alert" className="text-xs text-status-error">{credError}</p>}
          <button
            onClick={saveCredentialAndRecheck}
            disabled={credSaving || !hasInput}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-sm bg-amber-500 text-black font-medium hover:bg-amber-400 disabled:opacity-50 transition-colors"
          >
            {credSaving
              ? <><RefreshCw size={10} className="animate-spin" /> Saving &amp; re-checking…</>
              : <><Check size={10} /> Save &amp; re-check</>
            }
          </button>
        </div>
      )}

      {/* Hard error with no actionable credential field */}
      {result && !result.canBootstrap && !credentialNeeded && !loading && (
        <div className="rounded-sm border border-status-error/30 bg-status-error/5 px-3 py-2 text-xs text-status-error">
          Fix the errors above before bootstrapping.
        </div>
      )}

      {/* Re-check button */}
      {!loading && (
        <div className="flex justify-end">
          <button
            onClick={runPreflight}
            disabled={loading}
            className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-sm border border-border-subtle text-text-muted hover:text-accent hover:border-accent/40 transition-colors"
          >
            <RefreshCw size={10} /> Re-check
          </button>
        </div>
      )}
    </div>
  )
}
