'use client'

import { useState, useEffect, useRef } from 'react'
import { RefreshCw, Play } from 'lucide-react'
import type { Domain, Env } from '../types'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { apiFetch, errorMessage, readSSE, parseSSEData } from '@/lib/api'

export function DnsBootstrapPanel({ domain, environments, onDone }: {
  domain: Domain
  environments: Env[]
  onDone: (updates: Partial<Domain>) => void
}) {
  const [envId, setEnvId]     = useState(domain.coreDnsEnvironmentId ?? '')
  const [ip, setIp]           = useState(domain.coreDnsIp ?? '')
  const [running, setRunning] = useState(false)
  const [logs, setLogs]       = useState<string[]>([])
  const [err, setErr]         = useState('')
  const logsRef               = useRef<HTMLDivElement>(null)

  // Follow the log by scrolling its own box (scrollIntoView also scrolled the page)
  useEffect(() => { const el = logsRef.current; if (el) el.scrollTop = el.scrollHeight }, [logs])

  const bootstrap = async () => {
    setErr(''); setLogs([]); setRunning(true)
    try {
      await apiFetch(`/api/ingress/domains/${domain.id}`, {
        method: 'PATCH',
        body: { coreDnsEnvironmentId: envId || null, coreDnsIp: ip || null },
      })
      const res = await fetch(`/api/ingress/domains/${domain.id}/dns/bootstrap`, { method: 'POST' })
      if (!res.ok) throw new Error(`Request failed: ${res.status}`)
      if (!res.body) throw new Error('No response body')
      // readSSE buffers across chunk boundaries (the old per-chunk split threw on split events)
      for await (const raw of readSSE(res.body)) {
        const event = parseSSEData<{ type: string; message?: string; success?: boolean; error?: string }>(raw)
        if (!event) continue
        if (event.type === 'log' && event.message) setLogs(l => [...l, event.message!])
        if (event.type === 'done') {
          if (event.success) onDone({ coreDnsStatus: 'bootstrapped', coreDnsEnvironmentId: envId, coreDnsIp: ip || domain.coreDnsIp })
          else setErr(event.error ?? 'Bootstrap failed')
        }
      }
    } catch (e) { setErr(errorMessage(e)) }
    finally { setRunning(false) }
  }

  const selectedEnv = environments.find(e => e.id === envId)

  return (
    <div className="space-y-4">
      <div className="text-xs text-text-muted space-y-1">
        <p>Bootstrap deploys <strong className="text-text-primary">CoreDNS</strong> into a selected environment as the authoritative DNS server for <code className="font-mono text-accent">{domain.name}</code>.</p>
        <p>After bootstrap, records added here are automatically synced to CoreDNS via the gateway.</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">Environment</label>
          <Select aria-label="Environment" value={envId} onChange={e => setEnvId(e.target.value)}>
            <option value="">Select environment…</option>
            {environments.map(e => <option key={e.id} value={e.id}>{e.name} ({e.type})</option>)}
          </Select>
        </div>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">LoadBalancer IP <span className="text-text-muted font-normal">(optional)</span></label>
          <Input aria-label="LoadBalancer IP" value={ip} onChange={e => setIp(e.target.value)} placeholder="e.g. 192.168.1.53" />
        </div>
      </div>
      {selectedEnv && (
        <p className="text-[11px] text-text-muted">
          Deploy method: <span className="text-text-secondary font-medium">
            {selectedEnv.type === 'docker' ? 'Docker container (docker run coredns/coredns)' : 'Kubernetes manifests (Deployment + LoadBalancer Service)'}
          </span>
        </p>
      )}
      {logs.length > 0 && (
        <div ref={logsRef} role="log" aria-live="polite" className="bg-bg-canvas border border-border-subtle rounded-lg p-3 max-h-48 overflow-y-auto font-mono text-[11px] text-text-secondary space-y-0.5">
          {logs.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
      {err && <p className="text-xs text-status-error">{err}</p>}
      <Button onClick={bootstrap} disabled={running || !envId}>
        {running ? <RefreshCw size={12} className="animate-spin" /> : <Play size={12} />}
        {running ? 'Bootstrapping…' : domain.coreDnsStatus === 'bootstrapped' ? 'Re-bootstrap' : 'Bootstrap CoreDNS'}
      </Button>
    </div>
  )
}
