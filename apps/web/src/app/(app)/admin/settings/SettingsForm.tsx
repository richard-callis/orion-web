'use client'

import { useState, useTransition } from 'react'
import { Save, RefreshCw, Trash2 } from 'lucide-react'

interface ExternalModel {
  id:       string
  name:     string
  modelId:  string
  provider: string
  enabled:  boolean
}

interface CacheEntry {
  key:            string
  label:          string
  description:    string
  defaultSeconds: number
}

interface Props {
  initialSettings: Record<string, unknown>
  externalModels:  ExternalModel[]
  cacheRegistry:   CacheEntry[]
  saveSettings:    (entries: Array<{ key: string; value: string }>) => Promise<void>
  flushCaches:     () => Promise<void>
}

const GENERAL_DEFAULTS = {
  'app.name':                'ORION',
  'app.description':         '',
  'ai.default-model':        'claude',
  'chat.historyLimit':       10,
  'agent.chat.maxToolRounds': 15,
  'features.notes':          true,
  'features.backups':        true,
}

type GeneralSettings = typeof GENERAL_DEFAULTS

export function SettingsForm({
  initialSettings,
  externalModels,
  cacheRegistry,
  saveSettings,
  flushCaches,
}: Props) {
  // ── General settings state ────────────────────────────────────────────────
  const [general, setGeneral] = useState<GeneralSettings>({
    'app.name':                String(initialSettings['app.name'] ?? GENERAL_DEFAULTS['app.name']),
    'app.description':         String(initialSettings['app.description'] ?? ''),
    'ai.default-model':        String(initialSettings['ai.default-model'] ?? GENERAL_DEFAULTS['ai.default-model']),
    'chat.historyLimit':       parseInt(String(initialSettings['chat.historyLimit'])) || GENERAL_DEFAULTS['chat.historyLimit'],
    'agent.chat.maxToolRounds': parseInt(String(initialSettings['agent.chat.maxToolRounds'])) || GENERAL_DEFAULTS['agent.chat.maxToolRounds'],
    'features.notes':          initialSettings['features.notes'] === undefined
      ? GENERAL_DEFAULTS['features.notes']
      : initialSettings['features.notes'] === 'true' || initialSettings['features.notes'] === true,
    'features.backups':        initialSettings['features.backups'] === undefined
      ? GENERAL_DEFAULTS['features.backups']
      : initialSettings['features.backups'] === 'true' || initialSettings['features.backups'] === true,
  })

  // ── Cache TTL state ───────────────────────────────────────────────────────
  const [cacheTtls, setCacheTtls] = useState<Record<string, number>>(
    Object.fromEntries(
      cacheRegistry.map(c => [
        c.key,
        parseInt(String(initialSettings[c.key])) || c.defaultSeconds,
      ])
    )
  )

  // ── Action state ──────────────────────────────────────────────────────────
  const [isPending, startTransition] = useTransition()
  const [isFlushing, startFlush]     = useTransition()
  const [saved, setSaved]            = useState(false)
  const [flushed, setFlushed]        = useState(false)
  const [error, setError]            = useState<string | null>(null)

  const setGenField = <K extends keyof GeneralSettings>(key: K, value: GeneralSettings[K]) =>
    setGeneral(s => ({ ...s, [key]: value }))

  const handleSave = () => {
    setError(null)
    startTransition(async () => {
      try {
        const entries: Array<{ key: string; value: string }> = [
          ...Object.entries(general).map(([key, value]) => ({ key, value: String(value) })),
          ...Object.entries(cacheTtls).map(([key, value]) => ({ key, value: String(value) })),
        ]
        await saveSettings(entries)
        setSaved(true)
        setTimeout(() => setSaved(false), 2500)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to save settings')
      }
    })
  }

  const handleFlush = () => {
    startFlush(async () => {
      await flushCaches()
      setFlushed(true)
      setTimeout(() => setFlushed(false), 2500)
    })
  }

  return (
    <div className="p-6 space-y-8 max-w-2xl">
      <div>
        <h1 className="text-lg font-semibold text-text-primary">General Settings</h1>
        <p className="text-sm text-text-muted mt-0.5">Application-wide configuration</p>
      </div>

      {error && (
        <div className="rounded border border-status-error/40 bg-status-error/10 px-4 py-3 text-sm text-status-error">
          {error}
        </div>
      )}

      {/* ── General ────────────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-border-subtle bg-bg-card divide-y divide-border-subtle">
        <SettingRow label="App Name" description="Displayed in the header and browser tab">
          <input
            value={general['app.name']}
            onChange={e => setGenField('app.name', e.target.value)}
            className="input w-full"
          />
        </SettingRow>

        <SettingRow label="App Description" description="Short tagline shown on the dashboard">
          <input
            value={general['app.description']}
            onChange={e => setGenField('app.description', e.target.value)}
            placeholder="K3s Homelab Dashboard"
            className="input w-full"
          />
        </SettingRow>

        <SettingRow
          label="Default AI Model"
          description="Model used for AI features. Falls back to the first enabled external model if not set."
        >
          <select
            value={general['ai.default-model']}
            onChange={e => setGenField('ai.default-model', e.target.value)}
            className="input w-full"
          >
            <option value="claude">Claude (built-in)</option>
            {externalModels.map(m => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.modelId})
              </option>
            ))}
          </select>
        </SettingRow>

        <SettingRow label="Max History Messages" description="Number of messages to include in chat context">
          <input
            type="number" min={1} max={100}
            value={general['chat.historyLimit']}
            onChange={e => setGenField('chat.historyLimit', parseInt(e.target.value) || 10)}
            className="input w-32"
          />
        </SettingRow>

        <SettingRow
          label="Max Agent Wrench Rounds"
          description="How many tool calls a chat room agent can make before it must reply."
        >
          <input
            type="number" min={1} max={50}
            value={general['agent.chat.maxToolRounds']}
            onChange={e => setGenField('agent.chat.maxToolRounds', parseInt(e.target.value) || 15)}
            className="input w-32"
          />
        </SettingRow>

        <SettingRow label="Enable Notes" description="Show the Notes section in the sidebar">
          <Toggle value={general['features.notes']} onChange={v => setGenField('features.notes', v)} />
        </SettingRow>

        <SettingRow label="Enable Backups" description="Show the Backups section in the sidebar">
          <Toggle value={general['features.backups']} onChange={v => setGenField('features.backups', v)} />
        </SettingRow>
      </div>

      {/* ── Cache TTLs ─────────────────────────────────────────────────────── */}
      <div>
        <h2 className="text-base font-semibold text-text-primary">Cache Performance</h2>
        <p className="text-sm text-text-muted mt-0.5">
          In-process cache lifetimes. Lower values keep data fresher; higher values reduce database load.
          Changes take effect immediately on save.
        </p>
      </div>

      <div className="rounded-lg border border-border-subtle bg-bg-card divide-y divide-border-subtle">
        {cacheRegistry.map(c => (
          <SettingRow
            key={c.key}
            label={c.label}
            description={`${c.description} Default: ${c.defaultSeconds}s.`}
          >
            <div className="flex items-center gap-2">
              <input
                type="number" min={1}
                value={cacheTtls[c.key] ?? c.defaultSeconds}
                onChange={e =>
                  setCacheTtls(s => ({ ...s, [c.key]: parseInt(e.target.value) || c.defaultSeconds }))
                }
                className="input w-28"
              />
              <span className="text-xs text-text-muted">seconds</span>
            </div>
          </SettingRow>
        ))}
      </div>

      {/* ── Actions ────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={handleSave}
          disabled={isPending}
          className="flex items-center gap-2 px-4 py-2 rounded bg-accent text-white text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-50"
        >
          {isPending ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
          {isPending ? 'Saving…' : 'Save Settings'}
        </button>

        <button
          onClick={handleFlush}
          disabled={isFlushing}
          title="Clear all in-process caches immediately without changing settings"
          className="flex items-center gap-2 px-4 py-2 rounded border border-border-subtle bg-bg-raised text-text-secondary text-sm font-medium hover:bg-bg-card transition-colors disabled:opacity-50"
        >
          {isFlushing ? <RefreshCw size={14} className="animate-spin" /> : <Trash2 size={14} />}
          {isFlushing ? 'Flushing…' : 'Flush Caches'}
        </button>

        {saved  && <span className="text-sm text-status-healthy">Saved — caches flushed</span>}
        {flushed && !saved && <span className="text-sm text-status-healthy">Caches flushed</span>}
      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SettingRow({
  label,
  description,
  children,
}: {
  label:       string
  description: string
  children:    React.ReactNode
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
