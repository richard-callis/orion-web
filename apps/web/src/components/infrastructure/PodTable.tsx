'use client'
import { useState, useMemo, useEffect, useRef } from 'react'
import type { CachedPod } from '@/lib/k8s'
import { Search, MessageSquare, ChevronDown } from 'lucide-react'
import { useRouter } from 'next/navigation'
import type { AppModel } from '@/app/api/models/route'

const statusColor: Record<string, string> = {
  Running:     'text-status-healthy',
  Succeeded:   'text-status-info',
  Failed:      'text-status-error',
  Pending:     'text-status-warning',
  Terminating: 'text-text-muted',
  NotReady:    'text-status-warning',
  Unknown:     'text-text-muted',
}

function age(d: Date): string {
  const secs = (Date.now() - new Date(d).getTime()) / 1000
  if (secs < 3600) return `${Math.floor(secs / 60)}m`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`
  return `${Math.floor(secs / 86400)}d`
}

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Claude',
  ollama:    'Ollama',
  openai:    'OpenAI',
  google:    'Gemini',
  custom:    'Custom',
}

function DebugButton({ pod, models }: { pod: CachedPod; models: AppModel[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const startDebug = async (modelId?: string) => {
    setLoading(true)
    setOpen(false)
    const initialContext = `Debug pod \`${pod.name}\` in namespace \`${pod.namespace}\` on node \`${pod.node}\`.\n\nStatus: **${pod.status}**, Restarts: **${pod.restarts}**\n\nPlease check the logs and recent events to identify the issue.`
    const r = await fetch('/api/chat/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `Debug: ${pod.name}`,
        initialContext,
        metadata: { debugChat: true },
        ...(modelId && { planModel: modelId }),
      }),
    })
    const convo = await r.json()
    router.push(`/chat?conversation=${convo.id}`)
  }

  // Group models by provider
  const grouped = useMemo(() => {
    const map = new Map<string, AppModel[]>()
    for (const m of models) {
      const list = map.get(m.provider) ?? []
      list.push(m)
      map.set(m.provider, list)
    }
    return map
  }, [models])

  if (models.length === 0) {
    return (
      <button
        onClick={() => startDebug()}
        disabled={loading}
        className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
      >
        <MessageSquare size={12} />
        {loading ? '…' : 'Debug'}
      </button>
    )
  }

  return (
    <div className="relative inline-block" ref={ref}>
      <div className="inline-flex rounded overflow-hidden border border-accent/20">
        {/* Left side: quick-launch with default (Claude) */}
        <button
          onClick={() => startDebug()}
          disabled={loading}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
        >
          <MessageSquare size={12} />
          {loading ? '…' : 'Debug'}
        </button>
        {/* Right side: model picker */}
        <button
          onClick={() => setOpen(o => !o)}
          disabled={loading}
          className="px-1 py-1 text-xs bg-accent/10 text-accent hover:bg-accent/20 transition-colors border-l border-accent/20 disabled:opacity-50"
          title="Choose AI model"
        >
          <ChevronDown size={11} />
        </button>
      </div>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-52 rounded-lg border border-border-subtle bg-bg-card shadow-xl py-1">
          <p className="px-3 py-1.5 text-[10px] font-semibold text-text-muted uppercase tracking-wide">Debug with…</p>
          {Array.from(grouped.entries()).map(([provider, mList]) => (
            <div key={provider}>
              <p className="px-3 pt-1.5 pb-0.5 text-[10px] text-text-muted">{PROVIDER_LABEL[provider] ?? provider}</p>
              {mList.map(m => (
                <button
                  key={m.id}
                  onClick={() => startDebug(m.id)}
                  className="w-full text-left px-3 py-1.5 text-xs text-text-primary hover:bg-bg-raised transition-colors"
                >
                  {m.name}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function PodTable({ pods, nodeFilter }: { pods: CachedPod[]; nodeFilter?: string | null }) {
  const [search, setSearch] = useState('')
  const [nsFilter, setNsFilter] = useState('all')
  const [sortBy, setSortBy] = useState<'name' | 'namespace' | 'node' | 'status' | 'restarts'>('namespace')
  const [models, setModels] = useState<AppModel[]>([])

  useEffect(() => {
    fetch('/api/models').then(r => r.json()).then(setModels).catch(() => {})
  }, [])

  const namespaces = useMemo(() =>
    ['all', ...Array.from(new Set(pods.map(p => p.namespace))).sort()],
    [pods]
  )

  const filtered = useMemo(() => {
    let list = pods
    if (nodeFilter) list = list.filter(p => p.node === nodeFilter)
    if (nsFilter !== 'all') list = list.filter(p => p.namespace === nsFilter)
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(p =>
        p.name.includes(q) || p.namespace.includes(q) || p.node.includes(q)
      )
    }
    return [...list].sort((a, b) => {
      if (sortBy === 'restarts') return b.restarts - a.restarts
      return (a[sortBy] ?? '').localeCompare(b[sortBy] ?? '')
    })
  }, [pods, search, nsFilter, sortBy, nodeFilter])

  const col = (key: typeof sortBy, label: string) => (
    <th
      className={`px-3 py-2 text-left text-xs font-medium cursor-pointer select-none ${sortBy === key ? 'text-accent' : 'text-text-muted'}`}
      onClick={() => setSortBy(key)}
    >
      {label}{sortBy === key ? ' ↕' : ''}
    </th>
  )

  return (
    <section>
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <h2 className="text-sm font-semibold text-text-secondary flex items-center gap-2">
          Pods ({filtered.length}{filtered.length !== pods.length ? `/${pods.length}` : ''})
          {nodeFilter && (
            <span className="text-[10px] font-normal px-1.5 py-0.5 rounded bg-accent/15 text-accent font-mono">
              {nodeFilter.replace('k3s-', '').replace('homelab-', '')}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2 flex-1 flex-wrap">
          <div className="relative">
            <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Filter pods..."
              className="pl-7 pr-3 py-1.5 text-sm rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent w-48"
            />
          </div>
          <select
            value={nsFilter}
            onChange={e => setNsFilter(e.target.value)}
            className="px-2 py-1.5 text-sm rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent"
          >
            {namespaces.map(ns => <option key={ns} value={ns}>{ns}</option>)}
          </select>
        </div>
      </div>

      <div className="rounded-lg border border-border-subtle overflow-auto">
        <table className="w-full text-sm min-w-[700px]">
          <thead className="bg-bg-raised border-b border-border-subtle">
            <tr>
              {col('name',      'Pod')}
              {col('namespace', 'Namespace')}
              {col('node',      'Node')}
              {col('status',    'Status')}
              {col('restarts',  'Restarts')}
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Age</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-text-muted">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {filtered.map(pod => (
              <tr key={`${pod.namespace}/${pod.name}`} className="hover:bg-bg-raised transition-colors">
                <td className="px-3 py-2 font-mono text-xs text-text-primary max-w-[200px] truncate" title={pod.name}>
                  {pod.name}
                </td>
                <td className="px-3 py-2 text-xs text-text-secondary">{pod.namespace}</td>
                <td className="px-3 py-2 font-mono text-xs text-text-muted">
                  {pod.node.replace('k3s-', '').replace('homelab-', '')}
                </td>
                <td className={`px-3 py-2 text-xs font-medium ${statusColor[pod.status] ?? 'text-text-muted'}`}>
                  {pod.status}
                </td>
                <td className={`px-3 py-2 text-xs font-mono ${pod.restarts > 5 ? 'text-status-error' : pod.restarts > 0 ? 'text-status-warning' : 'text-text-muted'}`}>
                  {pod.restarts}
                </td>
                <td className="px-3 py-2 text-xs font-mono text-text-muted">{age(pod.age)}</td>
                <td className="px-3 py-2 text-right">
                  <DebugButton pod={pod} models={models} />
                </td>
              </tr>
            ))}
            {!filtered.length && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-text-muted text-sm">
                  No pods match filter
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
