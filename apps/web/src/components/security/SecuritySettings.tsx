'use client'

import { useState, useEffect } from 'react'
import { Shield, CheckCircle2, XCircle, Loader2, RefreshCw, Save, Database, Zap } from 'lucide-react'

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
  const [rules, setRules] = useState<{ id: string; name: string; ruleType: string; severity: number; enabled: boolean }[]>([])
  const [seedingRules, setSeedingRules] = useState(false)
  const [seedRulesMsg, setSeedRulesMsg] = useState<string | null>(null)
  const [seedingDemo, setSeedingDemo] = useState(false)
  const [seedDemoMsg, setSeedDemoMsg] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      try {
        const [cfgRes, rulesRes] = await Promise.all([
          fetch('/api/monitoring/security/config'),
          fetch('/api/monitoring/security/seed-rules'),
        ])
        const cfgData = await cfgRes.json()
        setConfig(cfgData.config ?? {})
        const rulesData = await rulesRes.json()
        setRules(rulesData.rules ?? [])
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

  async function seedRules() {
    setSeedingRules(true)
    setSeedRulesMsg(null)
    try {
      const res = await fetch('/api/monitoring/security/seed-rules', { method: 'POST' })
      const data = await res.json()
      setSeedRulesMsg(`Seeded ${data.seeded} correlation rules`)
      setRules(data.rules?.map((name: string) => ({ id: name, name, ruleType: '', severity: 0, enabled: true })) ?? [])
      // Reload rules
      const r2 = await fetch('/api/monitoring/security/seed-rules')
      const d2 = await r2.json()
      setRules(d2.rules ?? [])
    } catch {
      setSeedRulesMsg('Failed to seed rules')
    } finally {
      setSeedingRules(false)
      setTimeout(() => setSeedRulesMsg(null), 4000)
    }
  }

  async function injectDemoEvents() {
    setSeedingDemo(true)
    setSeedDemoMsg(null)
    try {
      const res = await fetch('/api/monitoring/security/demo-events', { method: 'POST' })
      const data = await res.json()
      setSeedDemoMsg(data.message ?? 'Demo events injected')
    } catch {
      setSeedDemoMsg('Failed to inject demo events')
    } finally {
      setSeedingDemo(false)
      setTimeout(() => setSeedDemoMsg(null), 5000)
    }
  }

  return (
    <div className="space-y-6">
      {/* Source config */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Shield size={20} className="text-accent" />
          <h2 className="text-base font-semibold text-text-primary">Security Sources</h2>
        </div>
        <p className="text-xs text-text-muted mb-3">Configure and test connections to security monitoring sources.</p>

        <div className="space-y-3">
          {sources.map(source => (
            <div key={source.key} className="bg-bg-raised border border-border-subtle rounded-xl p-4">
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
                className="w-full px-3 py-1.5 text-xs bg-bg-surface border border-border-subtle rounded-md font-mono text-text-primary focus:outline-none focus:border-accent"
                placeholder={source.default}
              />
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3 mt-3">
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

      {/* Correlation rules */}
      <div className="border-t border-border-subtle pt-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
              <Database size={16} className="text-accent" />
              Correlation Rules
            </h3>
            <p className="text-xs text-text-muted mt-0.5">
              Rules that group raw events into incidents. {rules.length > 0 ? `${rules.length} rules loaded.` : 'No rules configured.'}
            </p>
          </div>
          <button
            onClick={seedRules}
            disabled={seedingRules}
            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium border border-border-subtle rounded-lg hover:bg-bg-raised disabled:opacity-50 transition-colors"
          >
            {seedingRules ? <Loader2 size={12} className="animate-spin" /> : <Database size={12} />}
            {rules.length > 0 ? 'Re-seed defaults' : 'Seed default rules'}
          </button>
        </div>

        {seedRulesMsg && (
          <div className="text-xs text-status-healthy mb-2">{seedRulesMsg}</div>
        )}

        {rules.length > 0 ? (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {rules.map(rule => (
              <div key={rule.id} className="bg-bg-raised border border-border-subtle rounded-lg px-3 py-2">
                <div className="text-xs font-medium text-text-primary">{rule.name.replace(/_/g, ' ')}</div>
                <div className="text-[10px] text-text-muted mt-0.5">{rule.ruleType} · sev {rule.severity}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border-subtle px-4 py-6 text-center text-xs text-text-muted">
            No correlation rules found. Click "Seed default rules" to get started.
          </div>
        )}
      </div>

      {/* Demo data */}
      <div className="border-t border-border-subtle pt-5">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
              <Zap size={16} className="text-accent" />
              Demo Data
            </h3>
            <p className="text-xs text-text-muted mt-0.5">
              Inject realistic sample security events to test the pipeline end-to-end.
            </p>
          </div>
          <button
            onClick={injectDemoEvents}
            disabled={seedingDemo}
            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium border border-status-warning/40 text-status-warning rounded-lg hover:bg-status-warning/5 disabled:opacity-50 transition-colors"
          >
            {seedingDemo ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
            Inject demo events
          </button>
        </div>
        {seedDemoMsg && (
          <div className="text-xs text-status-healthy mt-1">{seedDemoMsg}</div>
        )}
        <p className="text-[11px] text-text-muted mt-1">
          Injects brute-force, port scan, K8s warnings, anomalies, and a malware signal. Run the correlator after to generate incidents.
        </p>
      </div>
    </div>
  )
}
