'use client'

import { useState } from 'react'
import { Globe, RefreshCw, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { DomainPanel } from './domain/DomainPanel'
import { NewDomainForm } from './domain/NewDomainForm'
import { useIngressData } from './useIngressData'

export function IngressPage() {
  const { domains, environments, loaded, loading, error, reload, updateDomain, addDomain } = useIngressData()
  // undefined = follow the default (first domain); null = user collapsed everything
  const [pickedId, setPickedId] = useState<string | null | undefined>(undefined)
  const selectedId = pickedId === undefined ? domains[0]?.id ?? null : pickedId

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
        <Button variant="secondary" onClick={reload} disabled={loading}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} aria-hidden />
          Refresh
        </Button>
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
        <div role="alert" className="flex items-center gap-2 px-4 py-3 rounded-lg border border-status-error/40 bg-status-error/10 text-status-error text-sm">
          <AlertCircle size={15} aria-hidden /> {error}
        </div>
      )}

      {!loaded && (
        <div className="flex items-center gap-2 text-text-muted text-sm py-8 justify-center" role="status">
          <RefreshCw size={14} className="animate-spin" aria-hidden /> Loading…
        </div>
      )}

      {loaded && domains.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-text-muted">
          <Globe size={40} className="opacity-30" aria-hidden />
          <p className="text-sm font-medium text-text-secondary">No domains defined yet</p>
          <p className="text-xs text-center max-w-xs">Add a domain to start mapping ingress points and routes.</p>
        </div>
      )}

      {/* Refreshes keep the list mounted so expanded panels and half-filled forms survive. */}
      {loaded && (
        <div className="space-y-3">
          {domains.map(d => (
            <DomainPanel
              key={d.id}
              domain={d}
              environments={environments}
              selected={selectedId === d.id}
              onSelect={() => setPickedId(selectedId === d.id ? null : d.id)}
              onChange={updateDomain}
            />
          ))}
          <NewDomainForm onCreated={d => { void addDomain(d); setPickedId(d.id) }} />
        </div>
      )}
    </div>
  )
}
