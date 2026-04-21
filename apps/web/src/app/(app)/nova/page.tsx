'use client'
import { useState, useEffect } from 'react'
import {
  Search, Bot, Server, Plus, Trash2, X, Edit2, Copy, RefreshCw,
  ChevronDown, Tag, Calendar, Sparkles,
} from 'lucide-react'
import type { Nova, NovaCategory, NovaConfig } from '@/lib/nebula'

const CATEGORY_COLORS: Record<NovaCategory, string> = {
  Identity: 'bg-blue-500/20 text-blue-400 border border-blue-500/30',
  Storage: 'bg-purple-500/20 text-purple-400 border border-purple-500/30',
  Monitoring: 'bg-green-500/20 text-green-400 border border-green-500/30',
  DevTools: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
  Agent: 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30',
  Other: 'bg-gray-500/20 text-gray-400 border border-gray-500/30',
}

const SOURCE_COLORS: Record<Nova['source'], string> = {
  'bundled': 'bg-blue-500/15 text-blue-300 text-[10px] px-1.5 py-0.5 rounded',
  'remote': 'bg-purple-500/15 text-purple-300 text-[10px] px-1.5 py-0.5 rounded',
  'user-created': 'bg-amber-500/15 text-amber-300 text-[10px] px-1.5 py-0.5 rounded',
}

export default function NovaPage() {
  const [novae, setNovae] = useState<Nova[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<string>('')
  const [source, setSource] = useState<string>('')
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Nova | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const load = async () => {
    try {
      const res = await fetch('/api/novas')
      const data = await res.json()
      setNovae(data.novae || [])
    } catch { /* ignore */ }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const categories = Array.from(new Set(novae.map(n => n.category))) as NovaCategory[]

  const filtered = novae.filter(n => {
    if (category && n.category !== category) return false
    if (source && n.source !== source) return false
    if (search) {
      const q = search.toLowerCase()
      return (
        n.name.toLowerCase().includes(q) ||
        n.displayName.toLowerCase().includes(q) ||
        (n.description && n.description.toLowerCase().includes(q))
      )
    }
    return true
  })

  const handleDelete = async (nova: Nova) => {
    if (nova.source !== 'user-created') return
    setDeleting(nova.id)
    try {
      const res = await fetch(`/api/novas/${nova.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(await res.text())
      setNovae(prev => prev.filter(n => n.id !== nova.id))
    } catch (err) {
      console.error('Failed to delete Nova:', err)
    } finally {
      setDeleting(null)
    }
  }

  const handleEdit = (nova: Nova) => {
    setEditing(nova)
    setShowForm(true)
  }

  return (
    <div className="space-y-4 p-4 lg:p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <Sparkles size={18} className="text-accent" />
            Nova Catalog
          </h1>
          <p className="text-xs text-text-muted mt-1">
            Manage deployable service definitions — bundled, remote, and custom
          </p>
        </div>
        <button
          onClick={() => { setEditing(null); setShowForm(true) }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-accent/15 text-accent hover:bg-accent/25 transition-colors"
        >
          <Plus size={14} />
          New Nova
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-2 items-center flex-wrap">
        <div className="flex-1 min-w-[200px] relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search nova definitions..."
            className="w-full pl-8 pr-3 py-1.5 text-xs rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
          />
        </div>
        <select
          value={source}
          onChange={e => setSource(e.target.value)}
          className="px-2 py-1.5 text-xs rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent"
        >
          <option value="">All Sources</option>
          <option value="bundled">Bundled</option>
          <option value="remote">Remote</option>
          <option value="user-created">User-Created</option>
        </select>
        <select
          value={category}
          onChange={e => setCategory(e.target.value)}
          className="px-2 py-1.5 text-xs rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent"
        >
          <option value="">All Categories</option>
          {categories.map(cat => (
            <option key={cat} value={cat}>{cat}</option>
          ))}
        </select>
        <button
          onClick={() => { setSearch(''); setCategory(''); setSource(''); }}
          className="px-2 py-1.5 text-xs rounded text-text-muted hover:text-text-primary hover:bg-bg-raised transition-colors"
          disabled={!search && !category && !source}
        >
          Clear
        </button>
        <button
          onClick={load}
          className="px-2 py-1.5 text-xs rounded text-text-muted hover:text-text-primary hover:bg-bg-raised transition-colors"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {/* Nova List */}
      {loading ? (
        <div className="text-center py-12 text-text-muted text-sm">Loading Nova catalog...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-text-muted text-sm">
          No Nova definitions found.
        </div>
      ) : (
        <div className="rounded-lg border border-border-subtle overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg-raised border-b border-border-subtle">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-text-muted w-[40px]">
                  <Bot size={14} />
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Name</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Description</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Category</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Source</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Tags</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-text-muted w-[100px]">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {filtered.map(nova => (
                <tr key={nova.id} className="hover:bg-bg-raised group">
                  <td className="px-3 py-3">
                    {nova.config?.type === 'agent' ? (
                      <Bot size={16} className="text-accent" />
                    ) : (
                      <Server size={16} className="text-accent" />
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <div className="font-mono text-xs text-text-primary">{nova.name}</div>
                    <div className="text-[10px] text-text-muted">{nova.displayName}</div>
                  </td>
                  <td className="px-3 py-3 text-xs text-text-secondary max-w-[300px] truncate">
                    {nova.description || '—'}
                  </td>
                  <td className="px-3 py-3">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${CATEGORY_COLORS[nova.category] || CATEGORY_COLORS.Other}`}>
                      {nova.category}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <span className={SOURCE_COLORS[nova.source]}>{nova.source}</span>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap gap-1">
                      {nova.tags?.slice(0, 3).map(tag => (
                        <span key={tag} className="text-[9px] text-text-muted bg-bg-raised px-1.5 py-0.5 rounded flex items-center gap-0.5">
                          <Tag size={8} />
                          {tag}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      {nova.source === 'user-created' && (
                        <>
                          <button
                            onClick={() => handleEdit(nova)}
                            className="p-1 rounded text-text-muted hover:text-accent hover:bg-accent/10 transition-colors"
                            title="Edit"
                          >
                            <Edit2 size={14} />
                          </button>
                          <button
                            onClick={() => handleDelete(nova)}
                            disabled={deleting === nova.id}
                            className="p-1 rounded text-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                            title="Delete"
                          >
                            {deleting === nova.id ? (
                              <RefreshCw size={14} className="animate-spin" />
                            ) : (
                              <Trash2 size={14} />
                            )}
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Nova Form Modal */}
      {showForm && (
        <NovaFormModal
          initial={editing}
          onClose={() => { setShowForm(false); setEditing(null) }}
          onSave={() => { setShowForm(false); setEditing(null); load() }}
        />
      )}
    </div>
  )
}

// ── Nova Form Modal ─────────────────────────────────────────────────────────────

function NovaFormModal({ initial, onClose, onSave }: {
  initial: Nova | null
  onClose: () => void
  onSave: () => void
}) {
  const [name, setName] = useState(initial?.name || '')
  const [displayName, setDisplayName] = useState(initial?.displayName || '')
  const [description, setDescription] = useState(initial?.description || '')
  const [category, setCategory] = useState<NovaCategory>(initial?.category || 'Other')
  const [type, setType] = useState<'agent' | 'service'>(
    initial?.config?.type || 'service'
  )
  const [configStr, setConfigStr] = useState(
    initial ? JSON.stringify(initial.config, null, 2) : JSON.stringify({
      name: '',
      displayName: '',
      description: '',
      type: 'service',
    }, null, 2)
  )
  const [tags, setTags] = useState(initial?.tags?.join(', ') || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    setSaving(true)
    setError(null)

    let parsedConfig: NovaConfig
    try {
      parsedConfig = JSON.parse(configStr)
    } catch {
      setError('Invalid JSON in config')
      setSaving(false)
      return
    }

    if (!parsedConfig.name?.trim() || !parsedConfig.displayName?.trim()) {
      setError('name and displayName are required in config')
      setSaving(false)
      return
    }

    const body = {
      name: name.trim() || parsedConfig.name.trim(),
      displayName: displayName.trim() || parsedConfig.displayName.trim(),
      description: description.trim() || null,
      category,
      version: '1.0.0',
      config: parsedConfig,
      tags: tags.split(',').map(t => t.trim()).filter(Boolean),
    }

    const isEdit = !!initial
    const method = isEdit ? 'PUT' : 'POST'
    const url = isEdit ? `/api/novas/${initial.id}` : '/api/novas'

    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Request failed')
      }
      onSave()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-2xl bg-bg-card border border-border-subtle rounded-lg shadow-xl max-h-[90vh] overflow-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle flex-shrink-0">
          <h3 className="text-sm font-semibold text-text-primary">
            {initial ? 'Edit Nova' : 'New Nova Definition'}
          </h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary">
            <X size={16} />
          </button>
        </div>

        {/* Form */}
        <div className="p-4 space-y-4">
          {/* Name */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[10px] font-medium text-text-muted mb-1">Name (ID)</label>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="my-service"
                className="w-full px-2 py-1.5 text-xs rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent font-mono"
              />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-text-muted mb-1">Display Name</label>
              <input
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder="My Service"
                className="w-full px-2 py-1.5 text-xs rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
              />
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="block text-[10px] font-medium text-text-muted mb-1">Description</label>
            <input
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What does this service do?"
              className="w-full px-2 py-1.5 text-xs rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
            />
          </div>

          {/* Category and Type */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[10px] font-medium text-text-muted mb-1">Category</label>
              <select
                value={category}
                onChange={e => setCategory(e.target.value as NovaCategory)}
                className="w-full px-2 py-1.5 text-xs rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent"
              >
                {['Identity', 'Storage', 'Monitoring', 'DevTools', 'Agent', 'Other'].map(cat => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-medium text-text-muted mb-1">Type</label>
              <select
                value={type}
                onChange={e => setType(e.target.value as 'agent' | 'service')}
                className="w-full px-2 py-1.5 text-xs rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent"
              >
                <option value="service">Service</option>
                <option value="agent">Agent</option>
              </select>
            </div>
          </div>

          {/* Tags */}
          <div>
            <label className="block text-[10px] font-medium text-text-muted mb-1">
              Tags <span className="text-text-muted">(comma separated)</span>
            </label>
            <input
              value={tags}
              onChange={e => setTags(e.target.value)}
              placeholder="monitoring, grafana, metrics"
              className="w-full px-2 py-1.5 text-xs rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent"
            />
          </div>

          {/* Config JSON */}
          <div>
            <label className="block text-[10px] font-medium text-text-muted mb-1">Config (JSON)</label>
            <textarea
              value={configStr}
              onChange={e => setConfigStr(e.target.value)}
              rows={12}
              className="w-full px-2 py-1.5 text-xs rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent font-mono resize-none"
            />
          </div>

          {/* Error */}
          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded p-2">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border-subtle flex-shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded text-text-muted hover:text-text-primary hover:bg-bg-raised transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="px-3 py-1.5 text-xs rounded bg-accent/15 text-accent hover:bg-accent/25 transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : initial ? 'Update' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
