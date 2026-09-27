'use client'

import { useState, useEffect, useCallback } from 'react'
import { Globe, RefreshCw, AlertCircle } from 'lucide-react'
import { DomainPanel } from './domain/DomainPanel'
import { NewDomainForm } from './domain/NewDomainForm'
import { btnGhost } from './styles'
import type { Domain, Env } from './types'

export function IngressPage() {
  const [domains, setDomains]           = useState<Domain[]>([])
  const [environments, setEnvironments] = useState<Env[]>([])
  const [loading, setLoading]           = useState(true)
  // True once the first load finished. Refreshes keep the list mounted so
  // expanded panels and half-filled forms survive.
  const [loaded, setLoaded]             = useState(false)
  const [error, setError]               = useState<string | null>(null)
  const [selectedId, setSelectedId]     = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [dRes, eRes] = await Promise.all([
        fetch('/api/ingress/domains'),
        fetch('/api/environments'),
      ])
      if (!dRes.ok || !eRes.ok) throw new Error('Failed to fetch')
      const [d, e] = await Promise.all([dRes.json(), eRes.json()])
      setDomains(d)
      setEnvironments(e)
      setSelectedId(prev => prev ?? (d.length > 0 ? d[0].id : null))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setLoading(false)
      setLoaded(true)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const totalRoutes    = domains.reduce((s, d) => s + d.ingressPoints.reduce((ss, p) => ss + p.routes.length, 0), 0)
  const disabledRoutes = domains.reduce((s, d) => s + d.ingressPoints.reduce((ss, p) => ss + p.routes.filter(r => !r.enabled).length, 0), 0)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-text-primary">Ingress</h1>
          <p className="text-sm text-text-muted mt-0.5">
            Domains · ingress points · routes · middlewares
          </p>
        </div>
        <button onClick={load} disabled={loading} className={btnGhost}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {loaded && domains.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs text-text-muted px-2.5 py-1 rounded-full border border-border-subtle bg-bg-raised">
            {domains.length} domain{domains.length !== 1 ? 's' : ''}
          </span>
          <span className="text-xs text-text-muted px-2.5 py-1 rounded-full border border-border-subtle bg-bg-raised">
            {totalRoutes} route{totalRoutes !== 1 ? 's' : ''}
          </span>
          {disabledRoutes > 0 && (
            <span className="text-xs text-status-warning px-2.5 py-1 rounded-full border border-status-warning/30 bg-status-warning/10">
              {disabledRoutes} disabled
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg border border-status-error/40 bg-status-error/10 text-status-error text-sm">
          <AlertCircle size={15} /> {error}
        </div>
      )}

      {!loaded && (
        <div className="flex items-center gap-2 text-text-muted text-sm py-8 justify-center">
          <RefreshCw size={14} className="animate-spin" /> Loading…
        </div>
      )}

      {loaded && domains.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-text-muted">
          <Globe size={40} className="opacity-30" />
          <p className="text-sm font-medium text-text-secondary">No domains defined yet</p>
          <p className="text-xs text-center max-w-xs">Add a domain to start mapping ingress points and routes.</p>
        </div>
      )}

      {loaded && (
        <div className="space-y-3">
          {domains.map(d => (
            <DomainPanel
              key={d.id}
              domain={d}
              environments={environments}
              selected={selectedId === d.id}
              onSelect={() => setSelectedId(prev => prev === d.id ? null : d.id)}
              onChange={updated => setDomains(ds => ds.map(x => x.id === updated.id ? updated : x))}
            />
          ))}
          <NewDomainForm onCreated={d => { setDomains(prev => [...prev, d]); setSelectedId(d.id) }} />
        </div>
      )}
    </div>
  )
}
