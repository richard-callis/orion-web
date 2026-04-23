'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Globe, Plus, ChevronRight, ChevronDown, Server, Wifi, WifiOff,
  Pencil, Trash2, Check, X, RefreshCw, ExternalLink, Lock,
  AlertCircle, Shield, Zap, ShieldCheck, Settings2, Play, Terminal,
  DatabaseZap, KeyRound, Bot, UserCog,
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface IngressPath {
  path:      string
  service:   string
  port:      number
  namespace?: string
}

interface IngressMiddleware {
  id:             string
  ingressPointId: string
  name:           string
  type:           string
  config:         Record<string, unknown>
  enabled:        boolean
}

interface IngressRoute {
  id:             string
  host:           string
  paths:          IngressPath[]
  tls:            boolean
  middlewares:    string[]
  comment:        string | null
  enabled:        boolean
  disabledAt:     string | null
  disabledBy:     string | null
  ingressPointId: string
}

interface IngressPoint {
  id:            string
  domainId:      string
  name:          string
  type:          string
  ip:            string | null
  port:          number
  certManager:   boolean
  clusterIssuer: string | null
  status:        string
  comment:       string | null
  environment:   { id: string; name: string } | null
  routes:        IngressRoute[]
  middlewares:   IngressMiddleware[]
}

interface DnsRecord {
  id:        string
  domainId:  string
  ip:        string
  hostnames: string[]
  enabled:   boolean
  comment:   string | null
}

interface Domain {
  id:                   string
  name:                 string
  type:                 string
  notes:                string | null
  coreDnsEnvironmentId: string | null
  coreDnsIp:            string | null
  coreDnsStatus:        string
  ingressPoints:        IngressPoint[]
}

interface Env { id: string; name: string; type: string }

// ── Styles ────────────────────────────────────────────────────────────────────

const inputCls = 'w-full px-3 py-2 text-sm bg-bg-raised border border-border-subtle rounded text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors'
const btnPrimary = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-accent text-white font-medium hover:bg-accent/80 disabled:opacity-50 transition-colors'
const btnGhost = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-border-subtle text-text-muted hover:text-text-primary hover:border-accent/40 transition-colors'
const btnDanger = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-status-error/40 text-status-error hover:bg-status-error/10 transition-colors'

// ── Status dot ────────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  const color =
    status === 'bootstrapped' ? 'bg-status-healthy' :
    status === 'active'       ? 'bg-status-healthy' :
    status === 'error'        ? 'bg-status-error'   :
    'bg-text-muted'
  return <span className={`w-2 h-2 rounded-full flex-shrink-0 ${color}`} />
}

// ── Inline editable text ──────────────────────────────────────────────────────

function InlineEdit({
  value, placeholder, onSave, className = '',
}: {
  value: string | null; placeholder: string; onSave: (v: string) => Promise<void>; className?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft]     = useState(value ?? '')
  const [saving, setSaving]   = useState(false)

  const save = async () => {
    setSaving(true)
    await onSave(draft)
    setSaving(false)
    setEditing(false)
  }

  if (editing) {
    return (
      <span className="flex items-center gap-1">
        <input
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
          className="px-1.5 py-0.5 text-xs bg-bg-raised border border-accent rounded text-text-primary focus:outline-none w-48"
        />
        <button onClick={save} disabled={saving} className="text-status-healthy hover:opacity-80">
          {saving ? <RefreshCw size={11} className="animate-spin" /> : <Check size={11} />}
        </button>
        <button onClick={() => setEditing(false)} className="text-text-muted hover:text-text-primary"><X size={11} /></button>
      </span>
    )
  }
  return (
    <button
      onClick={() => { setDraft(value ?? ''); setEditing(true) }}
      className={`group flex items-center gap-1 text-left ${className}`}
      title="Click to edit"
    >
      <span className={value ? '' : 'italic text-text-muted/60'}>{value || placeholder}</span>
      <Pencil size={10} className="opacity-0 group-hover:opacity-60 text-text-muted flex-shrink-0" />
    </button>
  )
}

// ── Bootstrap panel ───────────────────────────────────────────────────────────

function BootstrapPanel({ pointId, onDone }: { pointId: string; onDone: (status: string) => void }) {
  const [running, setRunning]   = useState(false)
  const [notice, setNotice]     = useState<{ text: string; ok: boolean } | null>(null)

  const run = async () => {
    setRunning(true); setNotice(null)
    try {
      const res = await fetch(`/api/ingress/points/${pointId}/bootstrap`, { method: 'POST' })
      const data = await res.json() as { jobId?: string; error?: string }
      if (!res.ok || !data.jobId) {
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }
      setNotice({ text: 'Bootstrap started — check the Jobs panel for live progress.', ok: true })
      // Optimistically mark as bootstrapped so the UI reflects the attempt
      onDone('bootstrapped')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setNotice({ text: msg, ok: false })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button onClick={run} disabled={running} className={btnPrimary}>
          {running
            ? <><RefreshCw size={11} className="animate-spin" /> Starting…</>
            : <><Play size={11} /> Bootstrap</>
          }
        </button>
        {notice && (
          <span className={`text-xs ${notice.ok ? 'text-status-healthy' : 'text-status-error'}`}>
            {notice.text}
          </span>
        )}
      </div>
    </div>
  )
}

// ── Middleware row ─────────────────────────────────────────────────────────────

const MIDDLEWARE_TYPES = [
  { value: 'crowdsec',     label: 'CrowdSec bouncer',        icon: Shield },
  { value: 'forward-auth', label: 'Forward auth (Authentik)', icon: ShieldCheck },
  { value: 'rate-limit',   label: 'Rate limit',               icon: Zap },
  { value: 'basic-auth',   label: 'Basic auth',               icon: Lock },
  { value: 'headers',      label: 'Headers',                  icon: Settings2 },
  { value: 'custom',       label: 'Custom',                   icon: Settings2 },
]

function MiddlewareRow({ mw, onToggle, onDelete }: {
  mw: IngressMiddleware
  onToggle: () => Promise<void>
  onDelete: () => Promise<void>
}) {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy]       = useState(false)
  const typeInfo = MIDDLEWARE_TYPES.find(t => t.value === mw.type) ?? MIDDLEWARE_TYPES[MIDDLEWARE_TYPES.length - 1]
  const Icon = typeInfo.icon

  const doToggle = async () => { setBusy(true); await onToggle(); setBusy(false) }
  const doDelete = async () => { setBusy(true); await onDelete(); setBusy(false) }

  return (
    <div className={`flex items-center gap-3 px-3 py-2 rounded-lg border text-xs transition-colors ${
      mw.enabled ? 'border-border-subtle bg-bg-surface' : 'border-border-subtle/50 bg-bg-canvas opacity-60'
    }`}>
      <Icon size={13} className={mw.enabled ? 'text-accent flex-shrink-0' : 'text-text-muted flex-shrink-0'} />
      <div className="flex-1 min-w-0">
        <span className="font-mono font-medium text-text-primary">{mw.name}</span>
        <span className="ml-2 text-[10px] text-text-muted">{typeInfo.label}</span>
      </div>
      <button
        onClick={doToggle}
        disabled={busy}
        className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
          mw.enabled
            ? 'border-status-healthy/40 text-status-healthy hover:bg-status-healthy/10'
            : 'border-border-subtle text-text-muted hover:border-accent/40'
        }`}
      >
        {mw.enabled ? 'active' : 'off'}
      </button>
      {confirm ? (
        <span className="flex items-center gap-1">
          <button onClick={doDelete} disabled={busy} className="text-status-error hover:opacity-70">
            {busy ? <RefreshCw size={10} className="animate-spin" /> : <Check size={10} />}
          </button>
          <button onClick={() => setConfirm(false)} className="text-text-muted hover:text-text-primary"><X size={10} /></button>
        </span>
      ) : (
        <button onClick={() => setConfirm(true)} className="text-text-muted hover:text-status-error transition-colors">
          <Trash2 size={10} />
        </button>
      )}
    </div>
  )
}

// ── New Middleware form ────────────────────────────────────────────────────────

function NewMiddlewareForm({ pointId, onCreated }: { pointId: string; onCreated: (m: IngressMiddleware) => void }) {
  const [open, setOpen]     = useState(false)
  const [name, setName]     = useState('')
  const [type, setType]     = useState('crowdsec')
  const [namespace, setNs]  = useState('security')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!name.trim()) return
    setSaving(true)
    const res = await fetch(`/api/ingress/points/${pointId}/middlewares`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), type, config: { namespace } }),
    })
    const m = await res.json()
    onCreated(m)
    setName(''); setType('crowdsec'); setNs('security'); setOpen(false); setSaving(false)
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className={`${btnGhost} text-[11px] w-full justify-center mt-1`}>
        <Plus size={10} /> Add middleware
      </button>
    )
  }

  return (
    <div className="mt-2 p-3 rounded-lg border border-border-subtle bg-bg-raised space-y-2 text-xs">
      <div className="grid grid-cols-2 gap-2">
        <input
          autoFocus
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
          placeholder="e.g. crowdsec-bouncer"
          className={inputCls}
        />
        <select value={type} onChange={e => setType(e.target.value)} className={inputCls}>
          {MIDDLEWARE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>
      <input
        value={namespace}
        onChange={e => setNs(e.target.value)}
        placeholder="Namespace (e.g. security)"
        className={inputCls}
      />
      <div className="flex gap-2">
        <button onClick={submit} disabled={saving || !name.trim()} className={btnPrimary}>
          {saving ? <RefreshCw size={11} className="animate-spin" /> : <Plus size={11} />} Add
        </button>
        <button onClick={() => setOpen(false)} className={btnGhost}>Cancel</button>
      </div>
    </div>
  )
}

// ── SSO Provider bootstrap ───────────────────────────────────────────────────

interface SSOProviderInfo {
  name: string
  displayName: string
  description: string
  source?: 'bundled' | 'remote' | 'local'
  hasHelm?: boolean
  hasOverlaySecret?: boolean
  hasCleanup?: boolean
}

const SSO_PROVIDER_TYPES: Record<string, {
  label: string
  icon: typeof KeyRound
  description: string
  fields: string[]
}> = {
  authentik:    { label: 'Authentik',     icon: KeyRound, description: 'Open-source identity provider with SSO, MFA & SCIM', fields: ['hostname','adminPassword','namespace','clusterIssuer'] },
  authelia:     { label: 'Authelia',      icon: Shield,   description: 'Authorization server for multi-factor access control', fields: ['hostname','adminPassword','namespace','databaseType','redisHost'] },
  oauth2_proxy: { label: 'OAuth2 Proxy',  icon: Lock,     description: 'Lightweight OIDC proxy (requires external provider)', fields: ['hostname','oidcIssuerUrl','clientId','clientSecret','namespace'] },
  keycloak:     { label: 'Keycloak',      icon: UserCog,  description: 'Enterprise identity & access management (RH SSO)', fields: ['hostname','adminPassword','namespace','clusterIssuer'] },
  custom_oidc:  { label: 'Custom OIDC',   icon: Settings2, description: 'Generic OpenID Connect provider (any compliant server)', fields: ['hostname','oidcIssuerUrl','clientId','clientSecret','customIssuerCaSecret','namespace'] },
}

function SSOBootstrapModal({
  pointId, domainName, onDone, onClose,
}: {
  pointId: string; domainName: string; onDone: () => void; onClose: () => void
}) {
  const [providers, setProviders] = useState<SSOProviderInfo[]>([])
  const [provider, setProvider] = useState('authentik')
  const [hostname, setHostname] = useState('')
  const [adminPassword, setAdminPassword] = useState('')
  const [namespace, setNamespace] = useState('security')
  const [clusterIssuer, setClusterIssuer] = useState('letsencrypt-prod')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  // Provider-specific fields
  const [oidcIssuerUrl, setOidcIssuerUrl] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [databaseType, setDatabaseType] = useState('sqlite')
  const [redisHost, setRedisHost] = useState('')
  const [customIssuerCaSecret, setCustomIssuerCaSecret] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/api/ingress/providers')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!cancelled) {
          setProviders(data?.providers ?? [])
          setLoading(false)
        }
      })
      .catch(() => { setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const providerInfo = SSO_PROVIDER_TYPES[provider]
  const remoteProvider = providers.find(p => p.name === provider)
  const resolved = {
    label: remoteProvider?.displayName ?? providerInfo?.label ?? provider,
    description: remoteProvider?.description ?? providerInfo?.description ?? '',
    fields: providerInfo?.fields ?? (remoteProvider?.hasHelm ? ['hostname','namespace','clusterIssuer'] : ['hostname','namespace']),
    hasHelm: remoteProvider?.hasHelm,
  }
  const Icon = providerInfo?.icon ?? (remoteProvider?.hasHelm ? KeyRound : Zap)

  const submit = async () => {
    setError('')
    if (!hostname.trim()) { setError('Hostname is required.'); return }

    const config: Record<string, unknown> = {
      provider,
      hostname: hostname.trim(),
      namespace: namespace || 'security',
    }
    if (adminPassword) config.adminPassword = adminPassword
    if (clusterIssuer) config.clusterIssuer = clusterIssuer
    if (oidcIssuerUrl) config.oidcIssuerUrl = oidcIssuerUrl
    if (clientId) config.clientId = clientId
    if (clientSecret) config.clientSecret = clientSecret
    if (databaseType) config.databaseType = databaseType
    if (redisHost) config.redisHost = redisHost
    if (customIssuerCaSecret) config.customIssuerCaSecret = customIssuerCaSecret

    setSaving(true)
    try {
      const res = await fetch(`/api/ingress/points/${pointId}/bootstrap-sso`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
      const data = await res.json()
      if (!res.ok || !data.jobId) {
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-lg max-h-[90vh] overflow-auto bg-[#1e1e2e] border border-border-subtle rounded-xl shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <div className="flex items-center gap-3">
            <Icon size={18} className="text-accent" />
            <div>
              <h2 className="text-sm font-semibold text-text-primary">Bootstrap Identity Provider</h2>
              <p className="text-[11px] text-text-muted">Deploy and configure an SSO provider for your services</p>
            </div>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3">
          {/* Provider selection */}
          <div>
            <label className="text-[11px] font-medium text-text-muted mb-1 block">Provider Type</label>
            <select value={provider} onChange={e => setProvider(e.target.value)} className={inputCls}>
              {loading && providers.length === 0
                ? <option value={provider}>Loading…</option>
                : (
                    Object.entries(SSO_PROVIDER_TYPES)
                      .filter(([key]) => !providers.some(p => p.name === key)) // show bundled ones not yet in remote
                      .map(([key, t]) => <option key={key} value={key}>{t.label}</option>)
                  )
                  .concat(providers.map(p => <option key={p.name} value={p.name}>{p.displayName}</option>))
              }
            </select>
            {resolved.description && <p className="text-[10px] text-text-muted mt-1">{resolved.description}</p>}
            {remoteProvider?.source === 'remote' && <span className="text-[9px] text-text-muted opacity-50">Loaded from orion-nub</span>}
          </div>

          {/* Hostname */}
          <div>
            <label className="text-[11px] font-medium text-text-muted mb-1 block">Hostname</label>
            <input
              autoFocus
              value={hostname}
              onChange={e => setHostname(e.target.value)}
              placeholder={`e.g. auth.${domainName}`}
              className={inputCls}
            />
          </div>

          {/* Namespace */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] font-medium text-text-muted mb-1 block">Namespace</label>
              <input
                value={namespace}
                onChange={e => setNamespace(e.target.value)}
                placeholder="security"
                className={inputCls}
              />
            </div>
            <div>
              <label className="text-[11px] font-medium text-text-muted mb-1 block">ClusterIssuer</label>
              <input
                value={clusterIssuer}
                onChange={e => setClusterIssuer(e.target.value)}
                placeholder="letsencrypt-prod"
                className={inputCls}
              />
            </div>
          </div>

          {/* Provider-specific: admin password */}
          {resolved.fields.includes('adminPassword') && (
            <div>
              <label className="text-[11px] font-medium text-text-muted mb-1 block">Admin Password</label>
              <input
                type="password"
                value={adminPassword}
                onChange={e => setAdminPassword(e.target.value)}
                placeholder="Set initial admin password"
                className={inputCls}
              />
            </div>
          )}

          {/* Provider-specific: OIDC fields */}
          {(provider === 'oauth2_proxy' || provider === 'custom_oidc') && (
            <>
              <div>
                <label className="text-[11px] font-medium text-text-muted mb-1 block">OIDC Issuer URL</label>
                <input
                  value={oidcIssuerUrl}
                  onChange={e => setOidcIssuerUrl(e.target.value)}
                  placeholder="https://auth.example.com/oauth2/token"
                  className={inputCls}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[11px] font-medium text-text-muted mb-1 block">Client ID</label>
                  <input
                    value={clientId}
                    onChange={e => setClientId(e.target.value)}
                    placeholder="oauth2-proxy-client"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-text-muted mb-1 block">Client Secret</label>
                  <input
                    type="password"
                    value={clientSecret}
                    onChange={e => setClientSecret(e.target.value)}
                    placeholder="client-secret-from-provider"
                    className={inputCls}
                  />
                </div>
              </div>
            </>
          )}

          {/* Provider-specific: Keycloak/Custom CA */}
          {provider === 'custom_oidc' && (
            <div>
              <label className="text-[11px] font-medium text-text-muted mb-1 block">Issuer CA Secret</label>
              <input
                value={customIssuerCaSecret}
                onChange={e => setCustomIssuerCaSecret(e.target.value)}
                placeholder="namespace/secret-name"
                className={inputCls}
              />
            </div>
          )}

          {/* Provider-specific: Authelia database */}
          {provider === 'authelia' && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[11px] font-medium text-text-muted mb-1 block">Database</label>
                <select value={databaseType} onChange={e => setDatabaseType(e.target.value)} className={inputCls}>
                  <option value="sqlite">SQLite</option>
                  <option value="postgresql">PostgreSQL</option>
                </select>
              </div>
              {databaseType === 'postgresql' && (
                <div>
                  <label className="text-[11px] font-medium text-text-muted mb-1 block">Redis Host</label>
                  <input
                    value={redisHost}
                    onChange={e => setRedisHost(e.target.value)}
                    placeholder="redis://redis:6379"
                    className={inputCls}
                  />
                </div>
              )}
            </div>
          )}

          {error && (
            <p className="text-xs text-status-error flex items-center gap-1">
              <AlertCircle size={12} /> {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-border-subtle bg-bg-raised">
          <button onClick={onClose} className={btnGhost}>Cancel</button>
          <button onClick={submit} disabled={saving || !hostname.trim()} className={btnPrimary}>
            {saving
              ? <><RefreshCw size={11} className="animate-spin" /> Deploying…</>
              : <><Play size={11} /> Deploy Provider</>
            }
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Middleware bootstrap (CrowdSec, Fail2Ban) ────────────────────────────────

const MIDDLEWARE_BOOTSTRAP_TYPES = [
  {
    value: 'crowdsec',  label: 'CrowdSec',        icon: Shield, description: 'Behavioral IPS with Traefik bouncer for automated IP banning',
    fields: ['namespace','clusterIssuer'],
  },
  {
    value: 'fail2ban',  label: 'Fail2Ban',        icon: Bot, description: 'Intrusion prevention via log monitoring (deployed as DaemonSet)',
    fields: ['namespace'],
  },
]

function MiddlewareBootstrapPanel({ pointId }: { pointId: string }) {
  const [modal, setModal] = useState<string | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null)

  // Auto-close the modal after a successful single-step bootstrap
  useEffect(() => {
    if (notice?.ok && !running) {
      const timer = setTimeout(() => setModal(null), 1500)
      return () => clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notice])

  const runBootstrap = async (type: string) => {
    setRunning(type); setNotice(null)
    try {
      const res = await fetch(`/api/ingress/points/${pointId}/bootstrap-middleware`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ middlewareType: type }),
      })
      const data = await res.json()
      if (!res.ok || !data.jobId) throw new Error(data.error ?? `HTTP ${res.status}`)
      setNotice({ text: `${type.charAt(0).toUpperCase() + type.slice(1)} bootstrap started — check the Jobs panel for progress.`, ok: true })
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : String(e), ok: false })
    } finally {
      setRunning(null)
    }
  }

  return (
    <>
      <div className="mt-3 pt-3 border-t border-border-subtle">
        <p className="text-[11px] font-medium text-text-muted mb-2">Deploy Infrastructure Middleware</p>
        <div className="grid grid-cols-2 gap-2">
          {MIDDLEWARE_BOOTSTRAP_TYPES.map(t => {
            const Icon = t.icon
            const isRunning = running === t.value
            return (
              <button
                key={t.value}
                onClick={() => setModal(t.value)}
                disabled={isRunning}
                className={`flex flex-col items-center gap-1.5 p-3 rounded-lg border border-border-subtle text-center transition-colors hover:bg-bg-raised hover:border-accent/40 ${isRunning ? 'opacity-50 cursor-wait' : ''}`}
              >
                <Icon size={18} className="text-accent" />
                <span className="text-[11px] font-medium text-text-primary">{t.label}</span>
              </button>
            )
          })}
        </div>
        {notice && (
          <p className={`text-xs mt-2 flex items-center gap-1 ${notice.ok ? 'text-status-healthy' : 'text-status-error'}`}>
            {notice.ok ? <Check size={12} /> : <AlertCircle size={12} />} {notice.text}
          </p>
        )}
      </div>

      {/* Inline middleware bootstrap modal */}
      {modal && (() => {
        const t = MIDDLEWARE_BOOTSTRAP_TYPES.find(x => x.value === modal)
        if (!t) return null
        const Icon = t.icon
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setModal(null)}>
            <div className="w-full max-w-md bg-[#1e1e2e] border border-border-subtle rounded-xl shadow-2xl" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
                <div className="flex items-center gap-3">
                  <Icon size={18} className="text-accent" />
                  <div>
                    <h2 className="text-sm font-semibold text-text-primary">Deploy {t.label}</h2>
                    <p className="text-[11px] text-text-muted">{t.description}</p>
                  </div>
                </div>
                <button onClick={() => setModal(null)} className="text-text-muted hover:text-text-primary"><X size={16} /></button>
              </div>
              <div className="px-5 py-4">
                <p className="text-xs text-text-muted">
                  This will deploy <strong>{t.label}</strong> into your cluster via the associated environment.
                  All config is managed through ORION playbooks.
                </p>
                <div className="flex gap-2 mt-4">
                  <button onClick={() => setModal(null)} className={btnGhost}>Cancel</button>
                  <button
                    onClick={() => { runBootstrap(modal) }}
                    disabled={running !== null}
                    className={btnPrimary}
                  >
                    {running === modal
                      ? <><RefreshCw size={11} className="animate-spin" /> Deploying…</>
                      : <><Play size={11} /> Deploy</>
                    }
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      })()}
    </>
  )
}

// ── New Domain form ───────────────────────────────────────────────────────────

function NewDomainForm({ onCreated }: { onCreated: (d: Domain) => void }) {
  const [open, setOpen]     = useState(false)
  const [name, setName]     = useState('')
  const [type, setType]     = useState('public')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!name.trim()) return
    setSaving(true)
    const res = await fetch('/api/ingress/domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type }),
    })
    const d = await res.json()
    onCreated(d)
    setName(''); setType('public'); setOpen(false); setSaving(false)
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className={`${btnGhost} w-full justify-center mt-2`}>
        <Plus size={12} /> Add domain
      </button>
    )
  }
  return (
    <div className="mt-2 p-3 rounded-lg border border-border-subtle bg-bg-raised space-y-2">
      <input
        autoFocus
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && submit()}
        placeholder="khalisio.com"
        className={inputCls}
      />
      <select value={type} onChange={e => setType(e.target.value)} className={inputCls}>
        <option value="public">Public</option>
        <option value="internal">Internal (LAN only)</option>
      </select>
      <div className="flex gap-2">
        <button onClick={submit} disabled={saving || !name.trim()} className={btnPrimary}>
          {saving ? <RefreshCw size={11} className="animate-spin" /> : <Plus size={11} />}
          Create
        </button>
        <button onClick={() => setOpen(false)} className={btnGhost}>Cancel</button>
      </div>
    </div>
  )
}

// ── New Ingress Point form ────────────────────────────────────────────────────

function NewPointForm({
  domainId, environments, onCreated,
}: {
  domainId: string; environments: Env[]; onCreated: (p: IngressPoint) => void
}) {
  const [open, setOpen]   = useState(false)
  const [form, setForm]   = useState({
    name: '', type: 'traefik', ip: '', port: '443',
    environmentId: '', certManager: true, clusterIssuer: 'letsencrypt-prod',
  })
  const [saving, setSaving] = useState(false)

  const set = (k: string, v: string | boolean) => setForm(f => ({ ...f, [k]: v }))

  const submit = async () => {
    if (!form.name.trim()) return
    setSaving(true)
    const res = await fetch(`/api/ingress/domains/${domainId}/points`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        port: Number(form.port) || 443,
        environmentId: form.environmentId || null,
      }),
    })
    const p = await res.json()
    onCreated(p)
    setForm({ name: '', type: 'traefik', ip: '', port: '443', environmentId: '', certManager: true, clusterIssuer: 'letsencrypt-prod' })
    setOpen(false); setSaving(false)
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className={`${btnGhost} text-[11px]`}>
        <Plus size={10} /> Add ingress point
      </button>
    )
  }
  return (
    <div className="mt-2 p-3 rounded-lg border border-border-subtle bg-bg-raised space-y-2 text-xs">
      <div className="grid grid-cols-2 gap-2">
        <input value={form.name} onChange={e => set('name', e.target.value)} placeholder="Name (e.g. Traefik)" className={inputCls} />
        <select value={form.type} onChange={e => set('type', e.target.value)} className={inputCls}>
          {['traefik','nginx','cilium','haproxy','cloudflare-tunnel','other'].map(t => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input value={form.ip} onChange={e => set('ip', e.target.value)} placeholder="VIP / IP (e.g. 10.2.2.200)" className={inputCls} />
        <input value={form.port} onChange={e => set('port', e.target.value)} placeholder="Port (443)" className={inputCls} />
      </div>
      <select value={form.environmentId} onChange={e => set('environmentId', e.target.value)} className={inputCls}>
        <option value="">No environment linked</option>
        {environments.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
      </select>
      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" checked={form.certManager} onChange={e => set('certManager', e.target.checked)} className="rounded" />
        <span className="text-text-secondary">Use cert-manager (Let&apos;s Encrypt)</span>
      </label>
      {form.certManager && (
        <input value={form.clusterIssuer} onChange={e => set('clusterIssuer', e.target.value)} placeholder="ClusterIssuer name" className={inputCls} />
      )}
      <div className="flex gap-2">
        <button onClick={submit} disabled={saving || !form.name.trim()} className={btnPrimary}>
          {saving ? <RefreshCw size={11} className="animate-spin" /> : <Plus size={11} />} Add
        </button>
        <button onClick={() => setOpen(false)} className={btnGhost}>Cancel</button>
      </div>
    </div>
  )
}

// ── New Route form ────────────────────────────────────────────────────────────

function NewRouteForm({
  pointId, domainName, availableMiddlewares, onCreated,
}: {
  pointId: string; domainName: string; availableMiddlewares: IngressMiddleware[]; onCreated: (r: IngressRoute) => void
}) {
  const [open, setOpen]             = useState(false)
  const [host, setHost]             = useState('')
  const [service, setService]       = useState('')
  const [port, setPort]             = useState('80')
  const [namespace, setNamespace]   = useState('default')
  const [tls, setTls]               = useState(true)
  const [comment, setComment]       = useState('')
  const [selMws, setSelMws]         = useState<string[]>([])
  const [saving, setSaving]         = useState(false)

  const toggleMw = (name: string) =>
    setSelMws(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name])

  const submit = async () => {
    if (!host.trim()) return
    setSaving(true)
    const res = await fetch(`/api/ingress/points/${pointId}/routes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: host.includes('.') ? host : `${host}.${domainName}`,
        tls,
        comment: comment || null,
        middlewares: selMws,
        paths: service ? [{ path: '/', service, port: Number(port) || 80, namespace }] : [],
      }),
    })
    const r = await res.json()
    onCreated(r)
    setHost(''); setService(''); setPort('80'); setNamespace('default'); setComment(''); setSelMws([]); setOpen(false); setSaving(false)
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className={`${btnGhost} text-[11px]`}>
        <Plus size={10} /> Add route
      </button>
    )
  }
  return (
    <div className="mt-2 p-3 rounded-lg border border-border-subtle bg-bg-raised space-y-2 text-xs">
      <input
        autoFocus
        value={host}
        onChange={e => setHost(e.target.value)}
        placeholder={`subdomain or full host (e.g. auth.${domainName})`}
        className={inputCls}
      />
      <div className="grid grid-cols-3 gap-2">
        <input value={service} onChange={e => setService(e.target.value)} placeholder="Service name" className={inputCls} />
        <input value={port} onChange={e => setPort(e.target.value)} placeholder="Port" className={inputCls} />
        <input value={namespace} onChange={e => setNamespace(e.target.value)} placeholder="Namespace" className={inputCls} />
      </div>
      <input value={comment} onChange={e => setComment(e.target.value)} placeholder="Comment (optional)" className={inputCls} />
      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" checked={tls} onChange={e => setTls(e.target.checked)} className="rounded" />
        <span className="text-text-secondary">TLS / HTTPS</span>
      </label>
      {availableMiddlewares.length > 0 && (
        <div className="space-y-1">
          <p className="text-text-muted text-[10px] uppercase tracking-wide">Middlewares</p>
          <div className="flex flex-wrap gap-1.5">
            {availableMiddlewares.map(mw => (
              <label key={mw.id} className={`flex items-center gap-1 px-2 py-0.5 rounded border cursor-pointer transition-colors text-[11px] ${
                selMws.includes(mw.name)
                  ? 'border-accent/60 bg-accent/10 text-accent'
                  : 'border-border-subtle text-text-muted hover:border-accent/30'
              }`}>
                <input
                  type="checkbox"
                  className="hidden"
                  checked={selMws.includes(mw.name)}
                  onChange={() => toggleMw(mw.name)}
                />
                {mw.name}
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="flex gap-2">
        <button onClick={submit} disabled={saving || !host.trim()} className={btnPrimary}>
          {saving ? <RefreshCw size={11} className="animate-spin" /> : <Plus size={11} />} Add route
        </button>
        <button onClick={() => setOpen(false)} className={btnGhost}>Cancel</button>
      </div>
    </div>
  )
}

// ── Route row ─────────────────────────────────────────────────────────────────

function RouteRow({ route, availableMiddlewares, onToggle, onDelete, onCommentSave, onMiddlewaresSave }: {
  route: IngressRoute
  availableMiddlewares: IngressMiddleware[]
  onToggle: () => Promise<void>
  onDelete: () => Promise<void>
  onCommentSave: (comment: string) => Promise<void>
  onMiddlewaresSave: (names: string[]) => Promise<void>
}) {
  const [toggling, setToggling]     = useState(false)
  const [deleting, setDeleting]     = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editMws, setEditMws]       = useState(false)
  const [selMws, setSelMws]         = useState<string[]>(route.middlewares ?? [])
  const [savingMws, setSavingMws]   = useState(false)

  const doToggle = async () => { setToggling(true); await onToggle(); setToggling(false) }
  const doDelete = async () => { setDeleting(true); await onDelete(); setDeleting(false) }

  const toggleMw = (name: string) =>
    setSelMws(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name])

  const saveMws = async () => {
    setSavingMws(true)
    await onMiddlewaresSave(selMws)
    setSavingMws(false)
    setEditMws(false)
  }

  const firstPath = Array.isArray(route.paths) && route.paths.length > 0
    ? route.paths[0] as IngressPath
    : null

  return (
    <div className={`rounded-lg border transition-colors ${
      route.enabled
        ? 'border-border-subtle bg-bg-surface hover:bg-bg-raised'
        : 'border-border-subtle/50 bg-bg-canvas opacity-60'
    }`}>
      <div className="flex items-start gap-3 px-3 py-2.5">
        {/* Toggle */}
        <button
          onClick={doToggle}
          disabled={toggling}
          title={route.enabled ? 'Disable route' : 'Enable route'}
          className={`mt-0.5 flex-shrink-0 transition-colors ${
            route.enabled ? 'text-status-healthy hover:text-status-error' : 'text-text-muted hover:text-status-healthy'
          }`}
        >
          {toggling
            ? <RefreshCw size={14} className="animate-spin" />
            : route.enabled ? <Wifi size={14} /> : <WifiOff size={14} />
          }
        </button>

        {/* Content */}
        <div className="flex-1 min-w-0 space-y-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <a
              href={`${route.tls ? 'https' : 'http'}://${route.host}`}
              target="_blank"
              rel="noopener noreferrer"
              className={`text-xs font-mono font-semibold flex items-center gap-1 ${
                route.enabled ? 'text-accent hover:underline' : 'text-text-muted line-through'
              }`}
            >
              {route.tls && <Lock size={9} className="flex-shrink-0" />}
              {route.host}
              <ExternalLink size={9} className="opacity-60" />
            </a>
            {firstPath && (
              <span className="text-[10px] text-text-muted font-mono bg-bg-raised px-1.5 py-0.5 rounded border border-border-subtle">
                → {firstPath.namespace ? `${firstPath.namespace}/` : ''}{firstPath.service}:{firstPath.port}
              </span>
            )}
            {!route.enabled && route.disabledBy && (
              <span className="text-[10px] text-text-muted italic">disabled by {route.disabledBy}</span>
            )}
          </div>

          {/* Middleware badges */}
          {(route.middlewares?.length > 0 || editMws) && (
            <div className="flex flex-wrap gap-1 pt-0.5">
              {!editMws && route.middlewares?.map(name => (
                <span key={name} className="text-[10px] px-1.5 py-0.5 rounded border border-accent/30 bg-accent/5 text-accent font-mono">
                  {name}
                </span>
              ))}
            </div>
          )}

          <InlineEdit
            value={route.comment}
            placeholder="Add a comment…"
            onSave={onCommentSave}
            className="text-[11px] text-text-muted"
          />
        </div>

        {/* Actions */}
        <div className="flex-shrink-0 flex items-center gap-1">
          {availableMiddlewares.length > 0 && (
            <button
              onClick={() => setEditMws(e => !e)}
              title="Edit middlewares"
              className={`transition-colors ${editMws ? 'text-accent' : 'text-text-muted hover:text-text-primary'}`}
            >
              <Shield size={11} />
            </button>
          )}
          {confirmDelete ? (
            <>
              <span className="text-[10px] text-status-error">Delete?</span>
              <button onClick={doDelete} disabled={deleting} className="text-status-error hover:opacity-70">
                {deleting ? <RefreshCw size={11} className="animate-spin" /> : <Check size={11} />}
              </button>
              <button onClick={() => setConfirmDelete(false)} className="text-text-muted hover:text-text-primary"><X size={11} /></button>
            </>
          ) : (
            <button onClick={() => setConfirmDelete(true)} className="text-text-muted hover:text-status-error transition-colors">
              <Trash2 size={11} />
            </button>
          )}
        </div>
      </div>

      {/* Middleware picker */}
      {editMws && availableMiddlewares.length > 0 && (
        <div className="px-3 pb-2.5 pt-0 flex items-center gap-2 flex-wrap border-t border-border-subtle/50 mt-1">
          <span className="text-[10px] text-text-muted">Middlewares:</span>
          {availableMiddlewares.map(mw => (
            <label key={mw.id} className={`flex items-center gap-1 px-1.5 py-0.5 rounded border cursor-pointer transition-colors text-[11px] ${
              selMws.includes(mw.name)
                ? 'border-accent/60 bg-accent/10 text-accent'
                : 'border-border-subtle text-text-muted hover:border-accent/30'
            }`}>
              <input type="checkbox" className="hidden" checked={selMws.includes(mw.name)} onChange={() => toggleMw(mw.name)} />
              {mw.name}
            </label>
          ))}
          <button onClick={saveMws} disabled={savingMws} className={btnPrimary}>
            {savingMws ? <RefreshCw size={10} className="animate-spin" /> : <Check size={10} />} Apply
          </button>
          <button onClick={() => { setSelMws(route.middlewares ?? []); setEditMws(false) }} className={btnGhost}>Cancel</button>
        </div>
      )}
    </div>
  )
}

// ── Ingress Point panel ───────────────────────────────────────────────────────

type PointTab = 'routes' | 'middlewares' | 'bootstrap'

function PointPanel({ point, domain, environments, onChange }: {
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

function DnsRecordModal({ domain, initial, suggestedIp, onSave, onClose }: {
  domain: Domain
  initial?: DnsRecord
  suggestedIp: string | null
  onSave: () => void
  onClose: () => void
}) {
  const editing = !!initial
  const [ip, setIp]               = useState(initial?.ip ?? suggestedIp ?? '')
  const [hostnames, setHostnames] = useState(initial?.hostnames.join(', ') ?? '')
  const [comment, setComment]     = useState(initial?.comment ?? '')
  const [saving, setSaving]       = useState(false)
  const [err, setErr]             = useState('')

  const save = async () => {
    const hosts = hostnames.split(/[\s,]+/).map(h => h.trim()).filter(Boolean)
    if (!ip.trim() || !hosts.length) { setErr('IP and at least one hostname are required.'); return }
    setSaving(true); setErr('')
    try {
      const url = editing
        ? `/api/ingress/domains/${domain.id}/dns/records/${initial!.id}`
        : `/api/ingress/domains/${domain.id}/dns/records`
      const r = await fetch(url, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: ip.trim(), hostnames: hosts, comment: comment || null }),
      })
      if (!r.ok) throw new Error((await r.json()).error ?? 'Failed to save')
      onSave(); onClose()
    } catch (e) { setErr(String(e)) }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-md bg-[#1e1e2e] border border-border-subtle rounded-xl shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <h2 className="text-sm font-semibold text-text-primary">{editing ? 'Edit DNS Record' : 'Add DNS Record'}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary"><X size={15} /></button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">IP Address</label>
            <input value={ip} onChange={e => setIp(e.target.value)} placeholder="e.g. 10.2.2.30" autoFocus className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Hostnames</label>
            <input
              value={hostnames}
              onChange={e => setHostnames(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && save()}
              placeholder={`*.${domain.name}, app.${domain.name}`}
              className={inputCls}
            />
            <p className="text-[11px] text-text-muted mt-1">Comma or space separated. Use <code className="font-mono">*.{domain.name}</code> for wildcard.</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Comment <span className="text-text-muted font-normal">(optional)</span></label>
            <input value={comment} onChange={e => setComment(e.target.value)} placeholder="e.g. Wildcard for all internal services" className={inputCls} />
          </div>
          {err && <p className="text-xs text-status-error">{err}</p>}
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border-subtle">
          <button onClick={onClose} className={btnGhost}>Cancel</button>
          <button onClick={save} disabled={saving} className={btnPrimary}>
            {saving ? <RefreshCw size={12} className="animate-spin" /> : <Check size={12} />}
            {editing ? 'Save changes' : 'Add record'}
          </button>
        </div>
      </div>
    </div>
  )
}

function DnsBootstrapPanel({ domain, environments, onDone }: {
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

function DomainDnsPanel({ domain, environments, ingressPointIp, onDomainChange }: {
  domain: Domain
  environments: Env[]
  ingressPointIp: string | null
  onDomainChange: (updates: Partial<Domain>) => void
}) {
  const [records, setRecords]   = useState<DnsRecord[]>([])
  const [loading, setLoading]   = useState(true)
  const [modal, setModal]       = useState<{ open: boolean; record?: DnsRecord }>({ open: false })
  const [deleting, setDeleting] = useState<string | null>(null)
  const [syncing, setSyncing]   = useState(false)
  const [dnsTab, setDnsTab]     = useState<'records' | 'bootstrap'>(
    domain.coreDnsStatus === 'bootstrapped' ? 'records' : 'bootstrap'
  )

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/ingress/domains/${domain.id}/dns/records`)
      const data = await res.json()
      setRecords(Array.isArray(data) ? data : [])
    } finally { setLoading(false) }
  }, [domain.id])

  useEffect(() => { load() }, [load])

  const hasWildcard = records.some(r => r.enabled && r.hostnames.some(h => h === `*.${domain.name}`))

  const del = async (record: DnsRecord) => {
    setDeleting(record.id)
    try {
      await fetch(`/api/ingress/domains/${domain.id}/dns/records/${record.id}`, { method: 'DELETE' })
      setRecords(rs => rs.filter(r => r.id !== record.id))
    } finally { setDeleting(null) }
  }

  const sync = async () => {
    setSyncing(true)
    try { await fetch(`/api/ingress/domains/${domain.id}/dns/sync`, { method: 'POST' }) }
    finally { setSyncing(false) }
  }

  const dnsBtnCls = (t: 'records' | 'bootstrap') =>
    `flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded transition-colors ${
      dnsTab === t ? 'bg-accent/10 text-accent' : 'text-text-muted hover:text-text-primary'
    }`

  return (
    <div className="space-y-3 min-w-0 overflow-hidden">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button className={dnsBtnCls('records')} onClick={() => setDnsTab('records')}>
            <DatabaseZap size={10} /> Records
            {domain.coreDnsStatus === 'bootstrapped' && <span className="ml-1 w-1.5 h-1.5 rounded-full bg-status-healthy inline-block" />}
          </button>
          <button className={dnsBtnCls('bootstrap')} onClick={() => setDnsTab('bootstrap')}>
            <Terminal size={10} /> Bootstrap
          </button>
        </div>
        {dnsTab === 'records' && (
          <div className="flex items-center gap-1.5">
            {domain.coreDnsStatus === 'bootstrapped' && (
              <button onClick={sync} disabled={syncing} className={btnGhost} title="Force sync to CoreDNS">
                <RefreshCw size={10} className={syncing ? 'animate-spin' : ''} /> Sync
              </button>
            )}
            <button onClick={() => setModal({ open: true })} className={btnPrimary}>
              <Plus size={11} /> Add Record
            </button>
          </div>
        )}
      </div>

      {dnsTab === 'bootstrap' ? (
        <DnsBootstrapPanel domain={domain} environments={environments} onDone={updates => { onDomainChange(updates); setDnsTab('records') }} />
      ) : (
        <>
          <div className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border ${hasWildcard ? 'border-status-healthy/30 bg-status-healthy/5 text-status-healthy' : 'border-status-warning/30 bg-status-warning/5 text-status-warning'}`}>
            <DatabaseZap size={11} className="flex-shrink-0" />
            {hasWildcard ? <>Wildcard <code className="font-mono">*.{domain.name}</code> active</> : <>No wildcard — add <code className="font-mono">*.{domain.name}</code> pointing to your Traefik IP</>}
          </div>
          {domain.coreDnsStatus !== 'bootstrapped' && (
            <div className="flex items-center gap-2 text-xs px-2.5 py-2 rounded-lg border border-status-warning/30 bg-status-warning/5 text-status-warning">
              <AlertCircle size={11} className="flex-shrink-0" />
              CoreDNS not bootstrapped — records saved but not served yet.
            </div>
          )}
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-text-muted py-2"><RefreshCw size={12} className="animate-spin" /> Loading…</div>
          ) : records.length === 0 ? (
            <p className="text-xs text-text-muted italic py-1">No DNS records yet.</p>
          ) : (
            <div className="space-y-1.5">
              {records.map(rec => (
                <div key={rec.id} className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors min-w-0 ${rec.enabled ? 'border-border-subtle bg-bg-surface hover:bg-bg-raised' : 'border-border-subtle/50 bg-bg-canvas opacity-60'}`}>
                  <code className="text-[11px] font-mono text-accent w-28 flex-shrink-0">{rec.ip}</code>
                  <div className="flex-1 flex flex-wrap gap-1 min-w-0 overflow-hidden">
                    {rec.hostnames.map(h => (
                      <span key={h} className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-border-subtle bg-bg-canvas text-text-secondary">{h}</span>
                    ))}
                  </div>
                  {rec.comment && <span className="text-[10px] text-text-muted truncate max-w-[100px]">{rec.comment}</span>}
                  <button onClick={() => setModal({ open: true, record: rec })} className="text-text-muted hover:text-text-primary transition-colors flex-shrink-0"><Pencil size={11} /></button>
                  <button onClick={() => del(rec)} disabled={deleting === rec.id} className="text-text-muted hover:text-status-error transition-colors flex-shrink-0">
                    {deleting === rec.id ? <RefreshCw size={11} className="animate-spin" /> : <Trash2 size={11} />}
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {modal.open && (
        <DnsRecordModal
          domain={domain}
          initial={modal.record}
          suggestedIp={ingressPointIp ?? domain.coreDnsIp}
          onSave={load}
          onClose={() => setModal({ open: false })}
        />
      )}
    </div>
  )
}

// ── Domain panel ──────────────────────────────────────────────────────────────

type DomainTab = 'ingress' | 'dns'

function DomainPanel({ domain, environments, selected, onSelect, onChange }: {
  domain: Domain
  environments: Env[]
  selected: boolean
  onSelect: () => void
  onChange: (updated: Domain) => void
}) {
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
        onClick={onSelect}
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
                const res = await fetch(`/api/ingress/domains/${domain.id}`, {
                  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes }),
                })
                onChange(await res.json())
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

export function IngressPage() {
  const [domains, setDomains]           = useState<Domain[]>([])
  const [environments, setEnvironments] = useState<Env[]>([])
  const [loading, setLoading]           = useState(true)
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
      if (d.length > 0 && !selectedId) setSelectedId(d[0].id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [selectedId])

  useEffect(() => { load() }, [])   // eslint-disable-line react-hooks/exhaustive-deps

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

      {!loading && domains.length > 0 && (
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

      {loading && (
        <div className="flex items-center gap-2 text-text-muted text-sm py-8 justify-center">
          <RefreshCw size={14} className="animate-spin" /> Loading…
        </div>
      )}

      {!loading && domains.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-text-muted">
          <Globe size={40} className="opacity-30" />
          <p className="text-sm font-medium text-text-secondary">No domains defined yet</p>
          <p className="text-xs text-center max-w-xs">Add a domain to start mapping ingress points and routes.</p>
        </div>
      )}

      {!loading && (
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
