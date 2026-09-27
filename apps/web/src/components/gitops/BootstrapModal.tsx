'use client'

import { useState, useEffect, useRef } from 'react'
import { RefreshCw, Rocket, X, Copy, Check, Bot } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { ClusterPreflightFlow } from '@/components/environments/ClusterPreflightFlow'
import { Dialog } from '@/components/ui/Dialog'
import { IconButton } from '@/components/ui/Button'
import { apiFetch, errorMessage } from '@/lib/api'
import { useSSEStream } from '@/hooks/useSSE'
import type { BootstrapEvent } from './types'

export function BootstrapModal({
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
  const stream = useSSEStream<BootstrapEvent>({
    isTerminal: e => e.type === 'done' || e.type === 'error',
    errorEvent: message => ({ type: 'error', message }),
  })
  const lines = stream.events
  const done = stream.done
  const streaming = stream.running && !stream.done
  const logRef = useRef<HTMLDivElement>(null)

  const [kubeconfigReady, setKubeconfigReady] = useState(!isCluster || hasKubeconfig)

  // Remote docker only: copy-paste command
  const [dockerCmd, setDockerCmd] = useState<string | null>(null)
  const [dockerLoading, setDockerLoading] = useState(false)
  const [dockerError, setDockerError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Keep the log scrolled to the newest line (scrollTop, so the page doesn't move)
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  // Remote docker: generate the copy-paste command on mount
  useEffect(() => {
    if (!isRemoteDocker) return
    let cancelled = false
    setDockerLoading(true)
    apiFetch<{ dockerCmd: string }>(`/api/environments/${envId}/generate-join`, {
      method: 'POST',
      body: { gatewayType: 'docker' },
    })
      .then(d => { if (!cancelled) setDockerCmd(d.dockerCmd) })
      .catch(err => { if (!cancelled) setDockerError(errorMessage(err)) })
      .finally(() => { if (!cancelled) setDockerLoading(false) })
    return () => { cancelled = true }
  }, [envId, isRemoteDocker])

  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current) }, [])
  const copyDockerCmd = () => {
    if (!dockerCmd) return
    navigator.clipboard.writeText(dockerCmd).then(() => {
      setCopied(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 2000)
    })
  }


  const { start } = stream

  // Localhost: auto-deploy on mount
  useEffect(() => {
    if (isLocalhost) void start(`/api/environments/${envId}/deploy-gateway`)
  }, [envId, isLocalhost, start])

  // Cluster: start bootstrap once kubeconfig is ready
  useEffect(() => {
    if (isCluster && kubeconfigReady) void start(`/api/environments/${envId}/bootstrap`)
  }, [envId, isCluster, kubeconfigReady, start])

  const router = useRouter()
  const [creatingTask, setCreatingTask] = useState(false)
  const [agentError, setAgentError] = useState<string | null>(null)

  const askAgentToDeploy = async () => {
    setCreatingTask(true)
    setAgentError(null)
    try {
      // Create a task for tracking
      const taskTitle = isCluster
        ? `Bootstrap ${envName}: deploy ArgoCD + ORION gateway`
        : `Deploy ORION gateway to ${envName}`
      await apiFetch('/api/tasks', {
        method: 'POST',
        body: {
          title: taskTitle,
          description: `Deploy the ORION gateway to the ${envName} environment (type: ${envType}, ID: ${envId}).`,
          priority: 'high',
        },
      })

      if (isLocalhost) {
        // Localhost: the deployment is fully automated via the Docker socket.
        // Just run it directly — no kubectl, no AI needed.
        setCreatingTask(false)
        void start(`/api/environments/${envId}/deploy-gateway`)
        return
      }

      // Remote docker / cluster: fetch the editable prompt from DB, then open chat
      const promptKey = isRemoteDocker ? 'bootstrap.docker' : 'bootstrap.cluster'
      // Non-admins can't read prompts — fall back to a built-in instruction.
      const template = await apiFetch<{ content: string }>(`/api/admin/prompts/${encodeURIComponent(promptKey)}`).catch(() => null)
      const context = template
        ? template.content.replace(/\{\{envId\}\}/g, envId).replace(/\{\{envName\}\}/g, envName)
        : `Deploy the ORION gateway to **${envName}** (type: \`${envType}\`, ID: \`${envId}\`).`

      const convo = await apiFetch<{ id: string }>('/api/chat/conversations', {
        method: 'POST',
        body: { initialContext: context },
      })
      onClose()
      // The chat page reads ?conversation= (was ?conversationId=, which opened an empty chat)
      router.push(`/chat?conversation=${encodeURIComponent(convo.id)}`)
    } catch (e) {
      setAgentError(errorMessage(e, 'Could not hand this off to an agent'))
      setCreatingTask(false)
    }
  }

  // Shared log panel — inset from modal walls with visible padding
  // A plain element (not an inner component) so it isn't remounted on every event.
  const logPanel = (
    <div ref={logRef} className="flex-1 overflow-y-auto px-4 py-3">
      <div className="bg-black rounded-lg border border-border-subtle p-4 space-y-1 font-mono text-xs min-h-[180px]" role="log" aria-live="polite">
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
      </div>
    </div>
  )

  const headerTitle =
    isLocalhost    ? `Deploying Gateway — ${envName}` :
    isRemoteDocker ? `Deploy Gateway — ${envName}` :
                     `Bootstrapping — ${envName}`

  const canClose = isRemoteDocker || done || !kubeconfigReady

  return (
    <Dialog
      onClose={() => { if (canClose) onClose() }}
      label={headerTitle}
      className="w-full max-w-2xl bg-bg-card border border-border-subtle rounded-xl shadow-2xl flex flex-col max-h-[80vh]"
      overlayClassName="bg-transparent bg-linear-to-br from-black/70 via-black/50 to-bg-sidebar/60"
      closeOnBackdrop={false}
    >

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
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-sm border border-border-subtle bg-bg-raised text-text-secondary hover:text-accent hover:border-accent/40 transition-colors disabled:opacity-40"
              title="Ask an AI agent to handle this"
            >
              <Bot size={13} />
              {creatingTask ? 'Opening…' : 'Ask Agent'}
            </button>
          )}
          {canClose && (
            <IconButton label="Close" onClick={onClose} className="p-1.5 hover:bg-bg-raised">
              <X size={16} />
            </IconButton>
          )}
        </div>
      </div>

      {agentError && (
        <p role="alert" className="px-5 pt-3 text-xs text-status-error">{agentError}</p>
      )}

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
                <IconButton
                  label={copied ? 'Copied' : 'Copy command'}
                  onClick={copyDockerCmd}
                  className="absolute top-2 right-2 p-1.5 bg-bg-raised border border-border-subtle"
                >
                  {copied ? <Check size={13} className="text-status-healthy" /> : <Copy size={13} />}
                </IconButton>
              </div>
              <p className="text-xs text-text-muted">Gateway appears connected in ORION within ~30 seconds.</p>
            </>
          )}
        </div>
      )}

      {/* ── Localhost: auto-deploy log ── */}
      {isLocalhost && logPanel}

      {/* ── Cluster: preflight → auto-detect credentials → bootstrap log ── */}
      {isCluster && !kubeconfigReady && (
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <ClusterPreflightFlow
            envId={envId}
            onReady={() => setKubeconfigReady(true)}
          />
        </div>
      )}
      {isCluster && kubeconfigReady && logPanel}

      {/* Footer — cluster bootstrap done */}
      {isCluster && done && (
        <div className="px-5 py-3 border-t border-border-subtle flex justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-sm bg-accent text-white hover:bg-accent/80 transition-colors">
            Close
          </button>
        </div>
      )}
    </Dialog>
  )
}

// ─── PR Table (shared by open + closed tabs) ──────────────────────────────────
