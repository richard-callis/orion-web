'use client'

import { useState } from 'react'
import { ChevronRight, ChevronDown, Server, Wifi, AlertCircle, Shield, Zap, ShieldCheck, Terminal, DatabaseZap, KeyRound } from 'lucide-react'
import { MiddlewareBootstrapPanel } from '../middleware/MiddlewareBootstrapPanel'
import { MiddlewareRow } from '../middleware/MiddlewareRow'
import { NewMiddlewareForm } from '../middleware/NewMiddlewareForm'
import { SSOBootstrapModal } from '../middleware/SSOBootstrapModal'
import { BootstrapPanel } from './BootstrapPanel'
import { NewRouteForm } from '../routes/NewRouteForm'
import { RouteRow } from '../routes/RouteRow'
import { StatusDot, InlineEdit } from '../shared'
import { btnPrimary } from '../styles'
import type { IngressPoint, Domain, Env, PointTab } from '../types'

export function PointPanel({ point, domain, environments, onChange }: {
  point: IngressPoint
  domain: Domain
  environments: Env[]
  onChange: (updated: IngressPoint) => void
}) {
  const [expanded, setExpanded]   = useState(true)
  const [tab, setTab]             = useState<PointTab>('routes')
  const [routes, setRoutes]       = useState(point.routes)
  const [middlewares, setMws]     = useState(point.middlewares ?? [])
  const [showSSOModal, setShowSSO] = useState(false)

  const patchPoint = async (data: Record<string, unknown>) => {
    const res = await fetch(`/api/ingress/points/${point.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    })
    const updated = await res.json()
    onChange(updated)
  }

  const toggleRoute = async (routeId: string) => {
    const res = await fetch(`/api/ingress/routes/${routeId}/toggle`, { method: 'POST' })
    const updated = await res.json()
    setRoutes(r => r.map(x => x.id === routeId ? updated : x))
  }

  const deleteRoute = async (routeId: string) => {
    await fetch(`/api/ingress/routes/${routeId}`, { method: 'DELETE' })
    setRoutes(r => r.filter(x => x.id !== routeId))
  }

  const saveRouteComment = async (routeId: string, comment: string) => {
    const res = await fetch(`/api/ingress/routes/${routeId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ comment }),
    })
    const updated = await res.json()
    setRoutes(r => r.map(x => x.id === routeId ? updated : x))
  }

  const saveRouteMiddlewares = async (routeId: string, mwNames: string[]) => {
    const res = await fetch(`/api/ingress/routes/${routeId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ middlewares: mwNames }),
    })
    const updated = await res.json()
    setRoutes(r => r.map(x => x.id === routeId ? updated : x))
  }

  const toggleMw = async (mwId: string) => {
    const mw = middlewares.find(m => m.id === mwId)
    if (!mw) return
    const res = await fetch(`/api/ingress/middlewares/${mwId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !mw.enabled }),
    })
    const updated = await res.json()
    setMws(ms => ms.map(m => m.id === mwId ? updated : m))
  }

  const deleteMw = async (mwId: string) => {
    await fetch(`/api/ingress/middlewares/${mwId}`, { method: 'DELETE' })
    setMws(ms => ms.filter(m => m.id !== mwId))
  }

  const enabledCount  = routes.filter(r => r.enabled).length
  const disabledCount = routes.length - enabledCount
  const activeMws     = middlewares.filter(m => m.enabled).length

  const tabCls = (t: PointTab) =>
    `px-3 py-1.5 text-[11px] font-medium rounded transition-colors ${
      tab === t ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'
    }`

  return (
    <div className="border border-border-subtle rounded-xl overflow-hidden">
      {/* Point header */}
      <div
        className="flex items-center gap-3 px-4 py-3 bg-bg-raised cursor-pointer hover:bg-bg-surface transition-colors select-none"
        onClick={() => setExpanded(e => !e)}
      >
        <StatusDot status={point.status} />
        <Server size={13} className="text-text-muted flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-text-primary">{point.name}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-canvas border border-border-subtle text-text-muted font-mono">{point.type}</span>
            {point.environment && (
              <span className="text-[10px] text-text-muted">
                via <span className="text-text-secondary">{point.environment.name}</span>
              </span>
            )}
            {point.certManager && (
              <span className="inline-flex items-center gap-0.5 text-[10px] text-status-healthy">
                <Shield size={9} /> TLS
              </span>
            )}
            {activeMws > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[10px] text-accent">
                <ShieldCheck size={9} /> {activeMws} mw
              </span>
            )}
          </div>
          <div className="text-[10px] text-text-muted mt-0.5">
            {routes.length} route{routes.length !== 1 ? 's' : ''}
            {disabledCount > 0 && <span className="text-status-warning ml-1">· {disabledCount} disabled</span>}
          </div>
        </div>

        {/* Right-side address pills */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {domain.type === 'internal' && (
            <span
              className={`inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-full border ${domain.coreDnsIp ? 'border-blue-500/30 bg-blue-500/5 text-blue-400' : 'border-border-subtle bg-bg-raised text-text-muted opacity-50'}`}
              title={domain.coreDnsIp ? 'CoreDNS address' : 'CoreDNS not bootstrapped'}
            >
              <DatabaseZap size={9} /> {domain.coreDnsIp ? `${domain.coreDnsIp}:53` : '—:53'}
            </span>
          )}
          <span
            className={`inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-full border ${point.ip ? 'border-accent/30 bg-accent/5 text-accent' : 'border-border-subtle bg-bg-raised text-text-muted opacity-50'}`}
            title={point.ip ? 'Traefik proxy address' : 'Proxy not bootstrapped'}
          >
            <Zap size={9} /> {point.ip ? `${point.ip}:${point.port}` : `—:${point.port}`}
          </span>
          {point.status !== 'bootstrapped' && point.status !== 'active' && (
            <span className="text-[10px] px-2 py-0.5 rounded border border-status-warning/40 bg-status-warning/10 text-status-warning font-medium">
              not bootstrapped
            </span>
          )}
        </div>

        {expanded ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
      </div>

      {expanded && (
        <div className="bg-bg-canvas">
          {/* Tabs */}
          <div className="flex items-center gap-1 px-4 pt-3 pb-0 border-b border-border-subtle">
            <button className={tabCls('routes')} onClick={() => setTab('routes')}>
              <span className="flex items-center gap-1"><Wifi size={10} /> Routes ({routes.length})</span>
            </button>
            <button className={tabCls('middlewares')} onClick={() => setTab('middlewares')}>
              <span className="flex items-center gap-1"><ShieldCheck size={10} /> Middlewares ({middlewares.length})</span>
            </button>
            <button className={tabCls('bootstrap')} onClick={() => setTab('bootstrap')}>
              <span className="flex items-center gap-1"><Terminal size={10} /> Bootstrap</span>
            </button>
          </div>

          <div className="px-4 py-3 space-y-2">
            {/* Comment */}
            <div className="text-[11px] text-text-muted pb-1 border-b border-border-subtle">
              <InlineEdit
                value={point.comment}
                placeholder="Add a note about this ingress point…"
                onSave={comment => patchPoint({ comment })}
              />
            </div>

            {/* Routes tab */}
            {tab === 'routes' && (
              <>
                {routes.length === 0 && (
                  <p className="text-xs text-text-muted italic py-1">No routes defined yet.</p>
                )}
                <div className="space-y-1.5">
                  {routes.map(r => (
                    <RouteRow
                      key={r.id}
                      route={r}
                      availableMiddlewares={middlewares.filter(m => m.enabled)}
                      onToggle={() => toggleRoute(r.id)}
                      onDelete={() => deleteRoute(r.id)}
                      onCommentSave={comment => saveRouteComment(r.id, comment)}
                      onMiddlewaresSave={names => saveRouteMiddlewares(r.id, names)}
                    />
                  ))}
                </div>
                <NewRouteForm
                  pointId={point.id}
                  domainName={domain.name}
                  availableMiddlewares={middlewares.filter(m => m.enabled)}
                  onCreated={r => setRoutes(prev => [...prev, r])}
                />
              </>
            )}

            {/* Middlewares tab */}
            {tab === 'middlewares' && (
              <div className="space-y-1.5">
                {middlewares.length === 0 && (
                  <p className="text-xs text-text-muted italic py-1">No middlewares defined. Add one to apply to routes.</p>
                )}
                <div className="space-y-1.5">
                  {middlewares.map(mw => (
                    <MiddlewareRow
                      key={mw.id}
                      mw={mw}
                      onToggle={() => toggleMw(mw.id)}
                      onDelete={() => deleteMw(mw.id)}
                    />
                  ))}
                </div>
                <NewMiddlewareForm
                  pointId={point.id}
                  onCreated={m => setMws(prev => [...prev, m])}
                />

                {/* SSO Provider bootstrap */}
                <div className="mt-3 pt-3 border-t border-border-subtle">
                  <p className="text-[11px] font-medium text-text-muted mb-2">Deploy Identity Provider (SSO)</p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      onClick={() => setShowSSO(true)}
                      className={`${btnPrimary} text-[11px]`}
                    >
                      <KeyRound size={11} /> Bootstrap SSO Provider
                    </button>
                    <span className="text-[10px] text-text-muted">
                      Authentik · Authelia · OAuth2 Proxy · Keycloak · Custom OIDC
                    </span>
                  </div>
                </div>

                {/* Infrastructure middleware bootstrap */}
                <MiddlewareBootstrapPanel pointId={point.id} />

                {/* SSO Bootstrap Modal */}
                {showSSOModal && (
                  <SSOBootstrapModal
                    pointId={point.id}
                    domainName={domain.name}
                    onDone={() => { setShowSSO(false) }}
                    onClose={() => { setShowSSO(false) }}
                  />
                )}
              </div>
            )}

            {/* Bootstrap tab */}
            {tab === 'bootstrap' && (
              <div className="space-y-3">
                <div className="text-xs text-text-muted space-y-1">
                  <p>Bootstrapping will deploy <strong className="text-text-primary">Traefik</strong> and <strong className="text-text-primary">cert-manager</strong> into the associated cluster environment.</p>
                  <div className="flex items-center gap-2">
                    <span>LoadBalancer IP (MetalLB):</span>
                    <InlineEdit
                      value={point.ip ?? ''}
                      placeholder="e.g. 10.2.2.200"
                      onSave={ip => patchPoint({ ip: ip || null })}
                    />
                    {!point.ip && (
                      <span className="text-status-warning flex items-center gap-1">
                        <AlertCircle size={11} /> Required for Kubernetes bootstrap
                      </span>
                    )}
                  </div>
                  {point.clusterIssuer && <p>ClusterIssuer: <code className="font-mono text-accent">{point.clusterIssuer}</code></p>}
                  {!point.environment && (
                    <p className="text-status-warning flex items-center gap-1">
                      <AlertCircle size={11} /> No environment linked — link one above before bootstrapping.
                    </p>
                  )}
                </div>
                {point.environment ? (
                  <BootstrapPanel
                    pointId={point.id}
                    onDone={status => onChange({ ...point, status, routes, middlewares })}
                  />
                ) : (
                  <p className="text-xs text-text-muted italic">Link an environment to enable bootstrapping.</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Domain DNS panel ─────────────────────────────────────────────────────────
