'use client'

import { useState, useEffect } from 'react'
import { X, RefreshCw, Lock, AlertCircle, Shield, Zap, Settings2, Play, KeyRound, UserCog } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { inputCls, btnPrimary, btnGhost } from '../styles'

export interface SSOProviderInfo {
  name: string
  displayName: string
  description: string
  source?: 'bundled' | 'remote' | 'local'
  hasHelm?: boolean
  hasOverlaySecret?: boolean
  hasCleanup?: boolean
}

export const SSO_PROVIDER_TYPES: Record<string, {
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

export function SSOBootstrapModal({
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
    <Dialog
      onClose={onClose}
      label="Bootstrap identity provider"
      className="w-full max-w-lg max-h-[90vh] overflow-auto bg-[#1e1e2e] border border-border-subtle rounded-xl shadow-2xl"
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
    </Dialog>
  )
}

// ── Middleware bootstrap (dynamic, Nova-driven) ───────────────────────────────
