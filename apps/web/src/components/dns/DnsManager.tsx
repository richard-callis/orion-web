'use client'
import { useState } from 'react'
import { Plus, Trash2, RefreshCw } from 'lucide-react'
import type { DnsEntry } from '@/lib/dns'

type Tab = 'nodehosts' | 'records'

export function DnsManager({
  initialNodeHosts,
  initialCustomRecords,
}: {
  initialNodeHosts: DnsEntry[]
  initialCustomRecords: DnsEntry[]
}) {
  const [tab, setTab] = useState<Tab>('nodehosts')
  const [nodeHosts, setNodeHosts] = useState(initialNodeHosts)
  const [customRecords, setCustomRecords] = useState(initialCustomRecords)
  const [form, setForm] = useState({ ip: '', hostnames: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const entries = tab === 'nodehosts' ? nodeHosts : customRecords
  const setEntries = tab === 'nodehosts' ? setNodeHosts : setCustomRecords
  const basePath = `/api/dns/${tab === 'nodehosts' ? 'nodehosts' : 'records'}`

  const refresh = async () => {
    setLoading(true)
    try {
      const [nh, cr] = await Promise.all([
        fetch('/api/dns/nodehosts').then(r => r.json()),
        fetch('/api/dns/records').then(r => r.json()),
      ])
      setNodeHosts(nh)
      setCustomRecords(cr)
    } finally {
      setLoading(false)
    }
  }

  const add = async () => {
    const hostnames = form.hostnames.split(/[\s,]+/).map(h => h.trim()).filter(Boolean)
    if (!form.ip || !hostnames.length) return
    setError('')
    try {
      const r = await fetch(basePath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: form.ip, hostnames }),
      })
      if (!r.ok) throw new Error((await r.json()).error)
      setForm({ ip: '', hostnames: '' })
      await refresh()
    } catch (e) {
      setError(String(e))
    }
  }

  const del = async (ip: string) => {
    try {
      await fetch(`${basePath}/${encodeURIComponent(ip)}`, { method: 'DELETE' })
      setEntries(prev => prev.filter(e => e.ip !== ip))
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <div className="space-y-4 p-4 lg:p-6">
      {/* Tabs */}
      <div className="flex gap-1 border-b border-border-subtle">
        {(['nodehosts', 'records'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t
                ? 'border-accent text-accent'
                : 'border-transparent text-text-muted hover:text-text-secondary'
            }`}
          >
            {t === 'nodehosts' ? 'Node Hosts' : 'Custom Records'}
          </button>
        ))}
        <button
          onClick={refresh}
          disabled={loading}
          className="ml-auto p-2 text-text-muted hover:text-text-secondary"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Add form */}
      <div className="flex gap-2 items-end flex-wrap">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-muted">IP Address</label>
          <input
            value={form.ip}
            onChange={e => setForm(f => ({ ...f, ip: e.target.value }))}
            placeholder="10.2.2.100"
            className="px-3 py-1.5 text-sm rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent w-36 font-mono"
          />
        </div>
        <div className="flex flex-col gap-1 flex-1 min-w-[200px]">
          <label className="text-xs text-text-muted">Hostname(s) — space or comma separated</label>
          <input
            value={form.hostnames}
            onChange={e => setForm(f => ({ ...f, hostnames: e.target.value }))}
            placeholder="myserver.khalis.corp"
            className="px-3 py-1.5 text-sm rounded border border-border-visible bg-bg-raised text-text-primary placeholder-text-muted focus:outline-none focus:border-accent font-mono"
          />
        </div>
        <button
          onClick={add}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-accent text-white text-sm hover:bg-accent/80 transition-colors"
        >
          <Plus size={14} /> Add
        </button>
      </div>

      {error && <p className="text-sm text-status-error">{error}</p>}

      {/* Table */}
      <div className="rounded-lg border border-border-subtle overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-bg-raised border-b border-border-subtle">
            <tr>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">IP</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Hostnames</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-text-muted">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {entries.map(e => (
              <tr key={e.ip} className="hover:bg-bg-raised">
                <td className="px-3 py-2 font-mono text-xs text-text-primary">{e.ip}</td>
                <td className="px-3 py-2 font-mono text-xs text-text-secondary">
                  {e.hostnames.join(' ')}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => del(e.ip)}
                    className="p-1 rounded text-text-muted hover:text-status-error hover:bg-status-error/10 transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
            {!entries.length && (
              <tr><td colSpan={3} className="px-3 py-6 text-center text-text-muted text-sm">No entries</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
