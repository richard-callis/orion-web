'use client'
import { useState, useEffect } from 'react'
import { Save, RefreshCw } from 'lucide-react'

interface Settings {
  'app.name': string
  'app.description': string
  'model.default': string
  'chat.historyLimit': number
  'features.notes': boolean
  'features.backups': boolean
}

const DEFAULTS: Settings = {
  'app.name': 'ORION',
  'app.description': '',
  'model.default': 'claude',
  'chat.historyLimit': 10,
  'features.notes': true,
  'features.backups': true,
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>(DEFAULTS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/admin/settings')
      .then(r => r.json())
      .then((data: Partial<Settings>) => {
        setSettings(s => ({ ...s, ...data }))
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      if (!res.ok) throw new Error('Failed to save')
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setSaving(false)
    }
  }

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings(s => ({ ...s, [key]: value }))
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center gap-2 text-text-muted text-sm">
        <RefreshCw size={14} className="animate-spin" />
        Loading settings...
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div>
        <h1 className="text-lg font-semibold text-text-primary">General Settings</h1>
        <p className="text-sm text-text-muted mt-0.5">Application-wide configuration</p>
      </div>

      {error && (
        <div className="rounded border border-status-error/40 bg-status-error/10 px-4 py-3 text-sm text-status-error">
          {error}
        </div>
      )}

      <div className="rounded-lg border border-border-subtle bg-bg-card divide-y divide-border-subtle">
        {/* App name */}
        <SettingRow label="App Name" description="Displayed in the header and browser tab">
          <input
            value={settings['app.name']}
            onChange={e => set('app.name', e.target.value)}
            className="w-full px-3 py-1.5 text-sm bg-bg-raised border border-border-subtle rounded text-text-primary focus:outline-none focus:border-accent transition-colors"
          />
        </SettingRow>

        {/* App description */}
        <SettingRow label="App Description" description="Short tagline shown on the dashboard">
          <input
            value={settings['app.description']}
            onChange={e => set('app.description', e.target.value)}
            placeholder="K3s Homelab Dashboard"
            className="w-full px-3 py-1.5 text-sm bg-bg-raised border border-border-subtle rounded text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors"
          />
        </SettingRow>

        {/* Default model */}
        <SettingRow label="Default Model" description="Model used by default in Claude Chat">
          <select
            value={settings['model.default']}
            onChange={e => set('model.default', e.target.value)}
            className="w-full px-3 py-1.5 text-sm bg-bg-raised border border-border-subtle rounded text-text-primary focus:outline-none focus:border-accent transition-colors"
          >
            <option value="claude">Claude (default)</option>
            <option value="ollama">Ollama</option>
          </select>
        </SettingRow>

        {/* History limit */}
        <SettingRow label="Max History Messages" description="Number of messages to include in chat context">
          <input
            type="number"
            min={1}
            max={100}
            value={settings['chat.historyLimit']}
            onChange={e => set('chat.historyLimit', parseInt(e.target.value) || 10)}
            className="w-32 px-3 py-1.5 text-sm bg-bg-raised border border-border-subtle rounded text-text-primary focus:outline-none focus:border-accent transition-colors"
          />
        </SettingRow>

        {/* Feature toggles */}
        <SettingRow label="Enable Notes" description="Show the Notes section in the sidebar">
          <Toggle
            value={settings['features.notes']}
            onChange={v => set('features.notes', v)}
          />
        </SettingRow>

        <SettingRow label="Enable Backups" description="Show the Backups section in the sidebar">
          <Toggle
            value={settings['features.backups']}
            onChange={v => set('features.backups', v)}
          />
        </SettingRow>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 rounded bg-accent text-white text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-50"
        >
          {saving ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
        {saved && <span className="text-sm text-status-healthy">Saved successfully</span>}
      </div>
    </div>
  )
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string
  description: string
  children: React.ReactNode
}) {
  return (
    <div className="px-4 py-4 flex items-start gap-4">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-text-primary">{label}</p>
        <p className="text-xs text-text-muted mt-0.5">{description}</p>
      </div>
      <div className="w-64 flex-shrink-0">{children}</div>
    </div>
  )
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
        value ? 'bg-accent' : 'bg-bg-raised border border-border-visible'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          value ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  )
}
