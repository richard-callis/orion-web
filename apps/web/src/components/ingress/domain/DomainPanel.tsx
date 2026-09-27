'use client'

import { useState } from 'react'
import { Globe, Server, DatabaseZap } from 'lucide-react'
import { DomainDnsPanel } from '../dns/DomainDnsPanel'
import { NewPointForm } from '../point/NewPointForm'
import { PointPanel } from '../point/PointPanel'
import { InlineEdit } from '../shared'
import type { IngressPoint, Domain, Env, DomainTab } from '../types'
import { apiFetch, errorMessage } from '@/lib/api'
import { useToast } from '@/components/ui/Toast'
import { clickableProps } from '@/components/ui/clickable'

export function DomainPanel({ domain, environments, selected, onSelect, onChange }: {
  domain: Domain
  environments: Env[]
  selected: boolean
  onSelect: () => void
  onChange: (updated: Domain) => void
}) {
  const toast = useToast()
  const [points, setPoints]       = useState(domain.ingressPoints)
  const [domainTab, setDomainTab] = useState<DomainTab>('ingress')

  const isInternal     = domain.type === 'internal'
  const totalRoutes    = points.reduce((s, p) => s + p.routes.length, 0)
  const disabledRoutes = points.reduce((s, p) => s + p.routes.filter(r => !r.enabled).length, 0)
  // Use the first IngressPoint's IP as a suggested IP for new DNS records
  const ingressIp      = points.find(p => p.ip)?.ip ?? null

  const handlePointChange = (updated: IngressPoint) => {
    setPoints(ps => ps.map(p => p.id === updated.id ? updated : p))
  }

  const domainTabCls = (t: DomainTab) =>
    `flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors ${
      domainTab === t
        ? 'border-accent text-accent'
        : 'border-transparent text-text-muted hover:text-text-secondary'
    }`

  return (
    <div
      className={`rounded-xl border transition-colors ${
        selected ? 'border-accent ring-1 ring-accent/20' : 'border-border-subtle hover:border-accent/40'
      }`}
    >
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none"
        {...clickableProps(onSelect, { expanded: selected })}
      >
        <Globe size={15} className={`flex-shrink-0 ${domain.type === 'public' ? 'text-accent' : 'text-text-muted'}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-text-primary">{domain.name}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${
              domain.type === 'public'
                ? 'bg-accent/10 border-accent/30 text-accent'
                : 'bg-bg-raised border-border-subtle text-text-muted'
            }`}>
              {domain.type}
            </span>
          </div>
          <div className="text-[10px] text-text-muted mt-0.5">
            {points.length} ingress point{points.length !== 1 ? 's' : ''}
            {' · '}{totalRoutes} route{totalRoutes !== 1 ? 's' : ''}
            {disabledRoutes > 0 && <span className="text-status-warning"> · {disabledRoutes} disabled</span>}
          </div>
        </div>
      </div>

      {selected && (
        <div className="border-t border-border-subtle bg-bg-canvas rounded-b-xl">
          {/* Tab bar — internal domains only */}
          {isInternal && (
            <div className="flex gap-1 px-4 border-b border-border-subtle">
              <button className={domainTabCls('ingress')} onClick={() => setDomainTab('ingress')}>
                <Server size={11} /> Ingress Points
              </button>
              <button className={domainTabCls('dns')} onClick={() => setDomainTab('dns')}>
                <DatabaseZap size={11} /> DNS
              </button>
            </div>
          )}

          <div className="px-4 py-4 space-y-3">
            <InlineEdit
              value={domain.notes}
              placeholder="Add notes about this domain…"
              onSave={async notes => {
                try {
                  onChange(await apiFetch<Domain>(`/api/ingress/domains/${domain.id}`, { method: 'PATCH', body: { notes } }))
                } catch (e) {
                  toast.error(`Failed to save notes: ${errorMessage(e)}`)
                }
              }}
              className="text-xs text-text-muted"
            />

            {/* DNS tab (internal only) */}
            {isInternal && domainTab === 'dns' ? (
              <DomainDnsPanel
                domain={domain}
                environments={environments}
                ingressPointIp={ingressIp}
                onDomainChange={updates => onChange({ ...domain, ...updates })}
              />
            ) : (
              <>
                <div className="space-y-3">
                  {points.map(p => (
                    <PointPanel
                      key={p.id}
                      point={p}
                      domain={domain}
                      environments={environments}
                      onChange={handlePointChange}
                    />
                  ))}
                </div>
                <NewPointForm
                  domainId={domain.id}
                  environments={environments}
                  onCreated={p => setPoints(prev => [...prev, { ...p, middlewares: [] }])}
                />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
