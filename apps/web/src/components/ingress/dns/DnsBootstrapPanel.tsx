'use client'

import { useState, useEffect, useRef } from 'react'
import { RefreshCw, Play } from 'lucide-react'
import { inputCls, btnPrimary } from '../styles'
import type { Domain, Env } from '../types'

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
  const logsEndRef            = useRef<HTMLDivElement>(null)

  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [logs])

  const bootstrap = async () => {
    setErr(''); setLogs([]); setRunning(true)
    await fetch(`/api/ingress/domains/${domain.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coreDnsEnvironmentId: envId || null, coreDnsIp: ip || null }),
    })
    try {
      const res = await fetch(`/api/ingress/domains/${domain.id}/dns/bootstrap`, { method: 'POST' })
      if (!res.ok) throw new Error(`Request failed: ${res.status}`)
      if (!res.body) throw new Error('No response body')
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        for (const line of value.split('\n')) {
          if (!line.startsWith('data:')) continue
          const event = JSON.parse(line.slice(5).trim())
          if (event.type === 'log') setLogs(l => [...l, event.message])
          if (event.type === 'done') {
            if (event.success) onDone({ coreDnsStatus: 'bootstrapped', coreDnsEnvironmentId: envId, coreDnsIp: ip || domain.coreDnsIp })
            else setErr(event.error ?? 'Bootstrap failed')
          }
        }
      }
    } catch (e) { setErr(String(e)) }
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
          <select value={envId} onChange={e => setEnvId(e.target.value)} className={inputCls}>
            <option value="">Select environment…</option>
            {environments.map(e => <option key={e.id} value={e.id}>{e.name} ({e.type})</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">LoadBalancer IP <span className="text-text-muted font-normal">(optional)</span></label>
          <input value={ip} onChange={e => setIp(e.target.value)} placeholder="e.g. 10.2.2.53" className={inputCls} />
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
        <div className="bg-bg-canvas border border-border-subtle rounded-lg p-3 max-h-48 overflow-y-auto font-mono text-[11px] text-text-secondary space-y-0.5">
          {logs.map((l, i) => <div key={i}>{l}</div>)}
          <div ref={logsEndRef} />
        </div>
      )}
      {err && <p className="text-xs text-status-error">{err}</p>}
      <button onClick={bootstrap} disabled={running || !envId} className={btnPrimary}>
        {running ? <RefreshCw size={12} className="animate-spin" /> : <Play size={12} />}
        {running ? 'Bootstrapping…' : domain.coreDnsStatus === 'bootstrapped' ? 'Re-bootstrap' : 'Bootstrap CoreDNS'}
      </button>
    </div>
  )
}
