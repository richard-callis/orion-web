'use client'
import { useState, useEffect } from 'react'
import { Save, RefreshCw, ExternalLink, ShieldCheck } from 'lucide-react'

interface OIDCConfig {
  id?: string
  name: string
  enabled: boolean
  headerMode: boolean
  groupMapping: Record<string, string> | null
}

const DEFAULT_MAPPING = {
  'orion-admins': 'admin',
  'orion-users': 'user',
}

export default function SSOPage() {
  const [config, setConfig] = useState<OIDCConfig | null>(null)
  const [mappingText, setMappingText] = useState('')
  const [mappingError, setMappingError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/admin/sso')
      .then(r => r.json())
      .then((data: OIDCConfig) => {
        setConfig(data)
        setMappingText(
          JSON.stringify(data.groupMapping ?? DEFAULT_MAPPING, null, 2)
        )
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const handleSave = async () => {
    setMappingError(null)
    let parsed: Record<string, string>
    try {
      parsed = JSON.parse(mappingText)
    } catch {
      setMappingError('Invalid JSON — check your group mapping syntax.')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/admin/sso', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupMapping: parsed }),
      })
      if (!res.ok) throw new Error('Failed to save')
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      setMappingError('Failed to save configuration.')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center gap-2 text-text-muted text-sm">
        <RefreshCw size={14} className="animate-spin" />
        Loading SSO configuration...
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div>
        <h1 className="text-lg font-semibold text-text-primary">SSO Configuration</h1>
        <p className="text-sm text-text-muted mt-0.5">Authentication and identity provider settings</p>
      </div>

      {/* Current mode card */}
      <div className="rounded-lg border border-status-healthy/30 bg-status-healthy/5 p-5">
        <div className="flex items-start gap-3">
          <ShieldCheck size={20} className="text-status-healthy flex-shrink-0 mt-0.5" />
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-text-primary">Authentik Header Mode</span>
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-status-healthy/15 text-status-healthy">
                Active
              </span>
            </div>
            <p className="text-sm text-text-secondary">
              Your Traefik ingress is configured with Authentik forward-auth middleware. ORION
              automatically reads authentication headers injected by Authentik — no OAuth
              redirect flow is needed.
            </p>
            <div className="pt-1 flex flex-wrap gap-2 font-mono text-xs text-text-muted">
              {['x-authentik-username', 'x-authentik-email', 'x-authentik-name', 'x-authentik-uid', 'x-authentik-groups'].map(h => (
                <span key={h} className="bg-bg-raised px-2 py-0.5 rounded">{h}</span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Group mapping */}
      <div className="rounded-lg border border-border-subtle bg-bg-card">
        <div className="px-4 py-3 border-b border-border-subtle">
          <h2 className="text-sm font-semibold text-text-primary">Group Mapping</h2>
          <p className="text-xs text-text-muted mt-0.5">
            Map Authentik group names to ORION roles. Roles: <code className="bg-bg-raised px-1 rounded">admin</code>{' '}
            <code className="bg-bg-raised px-1 rounded">user</code>{' '}
            <code className="bg-bg-raised px-1 rounded">readonly</code>
          </p>
        </div>
        <div className="p-4 space-y-3">
          <textarea
            value={mappingText}
            onChange={e => setMappingText(e.target.value)}
            rows={8}
            spellCheck={false}
            className="w-full font-mono text-xs px-3 py-2 bg-bg-raised border border-border-subtle rounded text-text-primary focus:outline-none focus:border-accent transition-colors resize-none"
          />
          {mappingError && (
            <p className="text-xs text-status-error">{mappingError}</p>
          )}
          <div className="flex items-center gap-3">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2 rounded bg-accent text-white text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              {saving ? <RefreshCw size={13} className="animate-spin" /> : <Save size={13} />}
              {saving ? 'Saving...' : 'Save Mapping'}
            </button>
            {saved && <span className="text-sm text-status-healthy">Saved</span>}
          </div>
        </div>
      </div>

      {/* Links */}
      <div className="rounded-lg border border-border-subtle bg-bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold text-text-primary">Links</h2>
        <a
          href="https://auth.khalisio.com"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-sm text-accent hover:underline"
        >
          <ExternalLink size={13} />
          Authentik Admin Panel
        </a>
      </div>

      {/* Coming soon section */}
      <div className="rounded-lg border border-border-subtle bg-bg-card p-4 opacity-50">
        <div className="flex items-center gap-2 mb-2">
          <h2 className="text-sm font-semibold text-text-primary">Direct OIDC</h2>
          <span className="text-xs px-2 py-0.5 rounded bg-bg-raised text-text-muted">Coming Soon</span>
        </div>
        <p className="text-sm text-text-muted">
          Direct OIDC flow for non-header-auth scenarios. Useful when running ORION outside of a Traefik/Authentik
          environment.
        </p>
      </div>
    </div>
  )
}
