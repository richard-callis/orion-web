'use client'
import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import { Cpu, Package, Settings, Download, X, CheckCircle, Clock } from 'lucide-react'

interface NebulaInstance {
  id: string
  name: string
  category: string // "skill" | "hook"
  isInstalled: boolean
  isEnabled: boolean
  isForked: boolean
  spec: string
  sourceNovaId: string | null
  novaDefinition?: {
    id: string
    name: string
    title: string
    description: string
    category: string
    version: string
  }
  hookLogs: Array<{ id: string; status: string }>
  skillLogs: Array<{ id: string }>
}

interface NovaDefinition {
  id: string
  name: string
  title: string
  description: string
  category: string
  version: string
  instances?: NebulaInstance
}

type Tab = 'installed' | 'catalog' | 'settings'

const CATEGORY_COLORS: Record<string, string> = {
  skill: 'bg-green-500/20 text-green-400 border border-green-500/30',
  hook: 'bg-orange-500/20 text-orange-400 border border-orange-500/30',
}

export default function NebulaPage() {
  const { id } = useParams() as { id: string }
  const [activeTab, setActiveTab] = useState<Tab>('installed')
  const [instances, setInstances] = useState<NebulaInstance[]>([])
  const [loading, setLoading] = useState(true)
  const [novaDefs, setNovaDefs] = useState<NovaDefinition[]>([])

  const loadInstances = async () => {
    try {
      const res = await fetch(`/api/environments/${id}/nebula`)
      const data = await res.json()
      // GET /api/environments/[id]/nebula returns an array directly
      setInstances(Array.isArray(data) ? data : (data.instances || []))
    } catch { /* ignore */ }
  }

  const loadNovaDefs = async () => {
    try {
      const res = await fetch(`/api/environments/${id}/nebula/discovery`)
      const data = await res.json()
      // GET /api/environments/[id]/nebula/discovery returns { defaults, installed, active }
      setNovaDefs(data.defaults || data.definitions || [])
    } catch { /* ignore */ }
  }

  useEffect(() => {
    loadInstances()
    loadNovaDefs()
  }, [id])

  const handleInstall = async (novaId: string, targetName?: string) => {
    try {
      const res = await fetch(`/api/environments/${id}/nebula/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ novaId, name: targetName }),
      })
      if (!res.ok) throw new Error(await res.text())
      loadInstances()
    } catch (err) {
      console.error('Install failed:', err)
    }
  }

  const handleUninstall = async (instanceId: string) => {
    try {
      const res = await fetch(`/api/environments/${id}/nebula/${instanceId}/uninstall`, {
        method: 'POST',
      })
      if (!res.ok) throw new Error(await res.text())
      loadInstances()
    } catch (err) {
      console.error('Uninstall failed:', err)
    }
  }

  const handleToggle = async (instanceId: string, enabled: boolean) => {
    try {
      const res = await fetch(`/api/environments/${id}/nebula/${instanceId}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      if (!res.ok) throw new Error(await res.text())
      setInstances(prev =>
        prev.map(i => i.id === instanceId ? { ...i, isEnabled: !i.isEnabled } : i)
      )
    } catch (err) {
      console.error('Toggle failed:', err)
    }
  }

  const installedInstances = instances.filter(i => i.isInstalled)
  const availableDefs = novaDefs.filter(d => !installedInstances.some(i => i.sourceNovaId === d.id))

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle flex-shrink-0">
        <div className="flex items-center gap-2">
          <Cpu size={18} className="text-accent" />
          <h1 className="text-sm font-semibold text-text-primary">Nebula</h1>
          <p className="text-xs text-text-muted ml-2">Manage skills and hooks</p>
        </div>
        <button
          onClick={() => { loadInstances(); loadNovaDefs() }}
          className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-raised transition-colors"
          title="Refresh"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 4v6h-6M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
        </button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 px-4 border-b border-border-subtle flex-shrink-0">
        {[
          { key: 'installed' as Tab, label: 'Installed', icon: Package, count: installedInstances.length },
          { key: 'catalog' as Tab, label: 'Catalog', icon: Download, count: availableDefs.length },
          { key: 'settings' as Tab, label: 'Settings', icon: Settings, count: instances.length },
        ].map(({ key, label, icon: Icon, count }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              activeTab === key
                ? 'border-accent text-accent'
                : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
          >
            <Icon size={13} />
            {label}
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${
              activeTab === key ? 'bg-accent/15 text-accent' : 'bg-bg-raised text-text-muted'
            }`}>
              {count}
            </span>
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-auto p-4">
        {activeTab === 'installed' && (
          <InstalledTab
            instances={installedInstances}
            onInstall={(novaId, name) => handleInstall(novaId, name)}
            onUninstall={handleUninstall}
          />
        )}
        {activeTab === 'catalog' && (
          <CatalogTab
            definitions={availableDefs}
            onInstall={handleInstall}
          />
        )}
        {activeTab === 'settings' && (
          <SettingsTab
            instances={instances}
            onToggle={handleToggle}
          />
        )}
      </div>
    </div>
  )
}

// ── Installed Tab ────────────────────────────────────────────────────────────────

function InstalledTab({
  instances,
  onInstall,
  onUninstall,
}: {
  instances: NebulaInstance[]
  onInstall: (novaId: string, name: string) => void
  onUninstall: (id: string) => void
}) {
  if (instances.length === 0) {
    return (
      <div className="text-center py-12 text-text-muted text-sm">
        No Nebula instances installed yet. Visit the Catalog to browse skills and hooks.
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {instances.map(inst => (
        <div
          key={inst.id}
          className="border border-border-subtle rounded-lg p-4 bg-bg-surface hover:border-accent/40 transition-colors"
        >
          <div className="flex items-center gap-2">
            <div className={`p-2 rounded ${inst.category === 'skill' ? 'bg-green-500/20' : 'bg-orange-500/20'}`}>
              {inst.category === 'skill' ? (
                <Package size={16} className="text-green-400" />
              ) : (
                <Settings size={16} className="text-orange-400" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-text-primary truncate">{inst.name}</span>
                {inst.isForked && (
                  <span className="text-[9px] px-1 py-0.5 rounded bg-purple-500/20 text-purple-400 font-medium">Fork</span>
                )}
              </div>
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${CATEGORY_COLORS[inst.category] || ''}`}>
                {inst.category}
              </span>
            </div>
          </div>

          {inst.novaDefinition?.description && (
            <p className="text-[10px] text-text-muted mt-2 line-clamp-2">{inst.novaDefinition.description}</p>
          )}

          {/* Stats */}
          <div className="flex items-center gap-3 mt-3 text-[10px] text-text-muted">
            <span className="flex items-center gap-1">
              <CheckCircle size={10} className="text-green-400" />
              {inst.hookLogs.length + inst.skillLogs.length} executions
            </span>
            {inst.isForked && (
              <span className="flex items-center gap-1">
                <Clock size={10} />
                Forked
              </span>
            )}
          </div>

          {/* Actions */}
          <div className="mt-3 pt-3 border-t border-border-subtle">
            <div className="flex gap-1.5">
              <button
                onClick={() => onUninstall(inst.id)}
                className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded text-[11px] bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
              >
                <X size={11} />
                Uninstall
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Catalog Tab ──────────────────────────────────────────────────────────────────

function CatalogTab({
  definitions,
  onInstall,
}: {
  definitions: NovaDefinition[]
  onInstall: (novaId: string, name: string) => void
}) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<string>('')

  const filtered = definitions.filter(d => {
    if (filter && d.category !== filter) return false
    if (search) {
      const q = search.toLowerCase()
      return d.name.toLowerCase().includes(q) || d.title.toLowerCase().includes(q)
    }
    return true
  })

  const categories = Array.from(new Set(definitions.map(d => d.category)))

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex gap-2 flex-wrap items-center">
        <div className="flex-1 min-w-[200px] relative">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search catalog..."
            className="w-full px-3 py-1.5 text-xs rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
          />
        </div>
        <select
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="px-2 py-1.5 text-xs rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent"
        >
          <option value="">All Categories</option>
          {categories.map(cat => (
            <option key={cat} value={cat}>{cat}</option>
          ))}
        </select>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map(def => (
          <div
            key={def.id}
            className="border border-border-subtle rounded-lg p-4 bg-bg-surface hover:border-accent/40 transition-colors"
          >
            <div className="flex items-start gap-2.5">
              <div className={`p-2 rounded ${def.category === 'skill' ? 'bg-green-500/20' : 'bg-orange-500/20'}`}>
                {def.category === 'skill' ? (
                  <Package size={16} className="text-green-400" />
                ) : (
                  <Settings size={16} className="text-orange-400" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium text-text-primary truncate">{def.title}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${CATEGORY_COLORS[def.category] || ''}`}>
                    {def.category}
                  </span>
                </div>
                {def.description && (
                  <p className="text-[10px] text-text-muted mt-1 line-clamp-2">{def.description}</p>
                )}
              </div>
            </div>

            <button
              onClick={() => onInstall(def.id, def.name)}
              className="mt-3 w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-xs bg-accent/15 text-accent hover:bg-accent/25 transition-colors"
            >
              <Download size={12} />
              Install
            </button>
          </div>
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12 text-text-muted text-sm">
          No catalog items match your filters.
        </div>
      )}
    </div>
  )
}

// ── Settings Tab ─────────────────────────────────────────────────────────────────

function SettingsTab({
  instances,
  onToggle,
}: {
  instances: NebulaInstance[]
  onToggle: (id: string, enabled: boolean) => void
}) {
  if (instances.length === 0) {
    return (
      <div className="text-center py-12 text-text-muted text-sm">
        No Nebula instances to configure.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {instances.map(inst => (
        <div
          key={inst.id}
          className="flex items-center justify-between px-4 py-3 border border-border-subtle rounded-lg bg-bg-surface"
        >
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded ${inst.category === 'skill' ? 'bg-green-500/20' : 'bg-orange-500/20'}`}>
              {inst.category === 'skill' ? (
                <Package size={14} className="text-green-400" />
              ) : (
                <Settings size={14} className="text-orange-400" />
              )}
            </div>
            <div>
              <div className="text-xs font-medium text-text-primary">{inst.name}</div>
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${CATEGORY_COLORS[inst.category] || ''}`}>
                {inst.category}
              </span>
              {inst.isForked && (
                <span className="text-[10px] text-purple-400 ml-2">Forked</span>
              )}
            </div>
          </div>

          {/* Toggle */}
          <button
            onClick={() => onToggle(inst.id, !inst.isEnabled)}
            className={`relative w-10 h-5 rounded-full transition-colors ${
              inst.isEnabled ? 'bg-green-500/30' : 'bg-bg-raised border border-border-visible'
            }`}
          >
            <span
              className={`absolute top-0.5 w-4 h-4 rounded-full transition-transform ${
                inst.isEnabled
                  ? 'translate-x-5 bg-green-400'
                  : 'translate-x-0.5 bg-text-muted'
              }`}
            />
          </button>
        </div>
      ))}
    </div>
  )
}
