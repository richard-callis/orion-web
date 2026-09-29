'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCheck, Copy, RefreshCw, Rocket, Server, Terminal } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input, labelClass } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { useToast } from '@/components/ui/Toast'
import { apiFetch, errorMessage } from '@/lib/api'
import { useSSEStream } from '@/hooks/useSSE'
import { BootstrapLogView, ModalHeader, errorLog, isTerminalLog, modalPanel } from '../shared'
import type { BootstrapLog, Environment, JoinResult } from '../types'

function CopyBlock({ label, icon, text, wrap }: { label: string; icon: React.ReactNode; text: string; wrap?: boolean }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const copy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-text-secondary flex items-center gap-1.5">{icon} {label}</span>
        <button onClick={copy} aria-label={`Copy ${label} command`}
          className="flex items-center gap-1 text-[10px] text-text-muted hover:text-accent transition-colors">
          {copied ? <CheckCheck size={11} className="text-status-healthy" aria-hidden /> : <Copy size={11} aria-hidden />}
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className={`text-[11px] font-mono bg-bg-raised border border-border-subtle rounded-sm p-3 overflow-x-auto text-text-secondary ${wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}`}>
        {text}
      </pre>
    </div>
  )
}

export function DeployGatewayModal({ env, onClose, onDeployed }: {
  env: Environment
  onClose: () => void
  /** Called after a successful local bootstrap so the page can reload. */
  onDeployed: () => void
}) {
  const toast = useToast()
  const id = useId()
  const [gatewayUrl, setGatewayUrl] = useState('')
  const [gatewayType, setGatewayType] = useState(env.type)
  const [result, setResult] = useState<JoinResult | null>(null)
  const [generating, setGenerating] = useState(false)

  const stream = useSSEStream<BootstrapLog>({
    isTerminal: isTerminalLog,
    errorEvent: errorLog,
    onEvent: e => { if (e.type === 'done') onDeployed() },
  })

  const localBootstrap = env.type === 'localhost' || env.type === 'docker'
  // Unmounting aborts the stream, so don't allow closing mid-deploy.
  const close = () => { if (!stream.running) onClose() }

  const generateJoinToken = async () => {
    setGenerating(true)
    try {
      setResult(await apiFetch<JoinResult>(`/api/environments/${env.id}/generate-join`, {
        method: 'POST',
        body: { gatewayUrl: gatewayUrl || undefined, gatewayType },
      }))
    } catch (e) {
      toast.error(`Failed to generate join token: ${errorMessage(e)}`)
    } finally {
      setGenerating(false)
    }
  }

  return createPortal(
    <Dialog onClose={close} closeOnEscape={!stream.running} closeOnBackdrop={!stream.running}
      label="Deploy gateway" className={`${modalPanel} max-w-lg`}>
      <ModalHeader title={`Deploy Gateway · ${env.name}`} onClose={stream.running ? undefined : onClose} icon={<Rocket size={14} className="text-accent" aria-hidden />} />

      <div className="p-5 space-y-4">
        {localBootstrap ? (
          stream.events.length === 0 && !stream.running ? (
            <>
              <p className="text-xs text-text-muted">
                Deploys the gateway container, creates a Gitea repo with CI/CD scaffold, and registers a self-hosted Actions runner — all in one click.
              </p>
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="secondary" onClick={onClose}>Cancel</Button>
                <Button onClick={() => stream.start(`/api/environments/${env.id}/deploy-gateway`)}>
                  <Rocket size={11} aria-hidden /> Deploy Everything
                </Button>
              </div>
            </>
          ) : (
            <>
              <BootstrapLogView logs={stream.events} running={stream.running && !stream.done} />
              {stream.done && (
                <div className="flex justify-end pt-1">
                  <Button onClick={onClose}>Done</Button>
                </div>
              )}
            </>
          )
        ) : !result ? (
          <>
            <p className="text-xs text-text-muted">
              Generate a one-time join token. The gateway uses it on first boot to register itself — no manual credential copying needed.
            </p>
            <div>
              <label htmlFor={`${id}-type`} className={labelClass}>Gateway Type</label>
              <Select id={`${id}-type`} value={gatewayType} onChange={e => setGatewayType(e.target.value)}>
                <option value="cluster">Cluster (kubectl)</option>
                <option value="docker">Docker Node</option>
                <option value="remote">Remote / Other</option>
              </Select>
            </div>
            <div>
              <label htmlFor={`${id}-url`} className={labelClass}>Gateway URL <span className="text-text-muted">(how ORION will reach this gateway after deployment)</span></label>
              <Input id={`${id}-url`} value={gatewayUrl} onChange={e => setGatewayUrl(e.target.value)}
                placeholder="http://192.168.1.84:3001 or http://orion-gateway.management.svc.cluster.local:3001" />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" onClick={onClose}>Cancel</Button>
              <Button onClick={generateJoinToken} disabled={generating}>
                {generating ? <RefreshCw size={11} className="animate-spin" aria-hidden /> : <Rocket size={11} aria-hidden />}
                {generating ? 'Generating…' : 'Generate Join Token'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="rounded-lg border border-status-healthy/30 bg-status-healthy/5 px-3 py-2 text-xs text-status-healthy">
              Token generated — expires {new Date(result.expiresAt).toLocaleString()}. One-time use only.
            </div>
            <CopyBlock label="Docker" icon={<Terminal size={11} aria-hidden />} text={result.dockerCmd} />
            <CopyBlock label="Kubernetes" icon={<Server size={11} aria-hidden />} text={result.kubectlCmd} wrap />
            <div className="flex justify-end pt-1">
              <Button onClick={onClose}>Done</Button>
            </div>
          </>
        )}
      </div>
    </Dialog>,
    document.body,
  )
}
