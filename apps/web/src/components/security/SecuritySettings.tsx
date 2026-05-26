'use client'

import { useState, useEffect } from 'react'
import { Shield, CheckCircle2, XCircle, Loader2, RefreshCw, Save } from 'lucide-react'

const sources = [
  { key: 'CROWDSEC_API', name: 'CrowdSec', desc: 'Brute-force & IP blocking', default: 'http://crowdsec-lapi.crowdsec:8080' },
  { key: 'NTOPNG_API', name: 'ntopng', desc: 'Network traffic analysis', default: 'http://ntopng.monitoring:3000' },
  { key: 'ELASTICSEARCH_URL', name: 'Elasticsearch', desc: 'Logs & flow data', default: 'http://elasticsearch-client.monitoring:9200' },
  { key: 'VICTORIA_METRICS_URL', name: 'VictoriaMetrics', desc: 'Metrics time-series DB', default: 'http://victoria-metrics.monitoring:8428' },
  { key: 'WAZUH_API', name: 'Wazuh', desc: 'Endpoint security & SIEM', default: 'https://wazuh-manager.security:55000' },
]

export default function SecuritySettings() {
  const [config, setConfig] = useState<Record<string, string>>({})
  const [testing, setTesting] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [results, setResults] = useState<Record<string, 'ok' | 'error' | null>>({})

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/monitoring/security/config')
        const data = await res.json()
        setConfig(data.config ?? {})
      } catch {}
    }
    load()
  }, [])

  async function testConnection(key: string) {
    setTesting(key)
    try {
      const res = await fetch(`/api/monitoring/security/connections/test?key=${key}`)
      const data = await res.json()
      setResults(prev => ({ ...prev, [key]: data.ok ? 'ok' as const : 'error' as const }))
    } catch {
      setResults(prev => ({ ...prev, [key]: 'error' as const }))
    }
    setTesting(null)
  }

  async function saveConfig() {
    setSaving(true)
    setSaved(false)
    try {
      const res = await fetch('/api/monitoring/security/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
      if (res.ok) {
        setSaved(true)
        setTimeout(() => setSaved(false), 3000)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 mb-2">
        <Shield size={20} className="text-accent" />
        <h2 className="text-base font-semibold text-text-primary">Security Sources</h2>
      </div>
      <p className="text-xs text-text-muted">Configure and test connections to security monitoring sources.</p>

      <div className="space-y-3">
        {sources.map(source => (
          <div key={source.key} className="bg-bg-surface border border-border-subtle rounded-xl p-4">
            <div className="flex items-start justify-between mb-2">
              <div>
                <div className="text-sm font-medium text-text-primary">{source.name}</div>
                <div className="text-[11px] text-text-muted">{source.desc}</div>
              </div>
              <button
                onClick={() => testConnection(source.key)}
                disabled={testing === source.key}
                className="flex items-center gap-1 px-2 py-1 text-xs text-text-muted hover:text-text-primary border border-border-subtle rounded-md disabled:opacity-50"
              >
                {testing === source.key ? <Loader2 size={12} className="animate-spin" /> :
                  results[source.key] === 'ok' ? <CheckCircle2 size={12} className="text-status-success" /> :
                  results[source.key] === 'error' ? <XCircle size={12} className="text-status-error" /> :
                  <RefreshCw size={12} />}
                Test
              </button>
            </div>
            <input
              type="text"
              value={config[source.key] || source.default}
              onChange={e => setConfig(prev => ({ ...prev, [source.key]: e.target.value }))}
              className="w-full px-3 py-1.5 text-xs bg-bg-raised border border-border-subtle rounded-md font-mono text-text-primary focus:outline-none focus:border-accent"
              placeholder={source.default}
            />
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={saveConfig}
          disabled={saving}
          className="flex items-center gap-1 px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-50 transition-colors"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Save Configuration
        </button>
        {saved && <span className="text-xs text-status-healthy flex items-center gap-1"><CheckCircle2 size={12} /> Saved</span>}
      </div>
    </div>
  )
}
