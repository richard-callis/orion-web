'use client'
import { useState, useEffect, useCallback } from 'react'
import { ShieldAlert, CheckCircle, XCircle, Clock, RefreshCw } from 'lucide-react'
import { apiFetch, errorMessage } from '@/lib/api'
import { useToast } from '@/components/ui/Toast'
import { Input } from '@/components/ui/Input'

interface ApprovalRequest {
  id: string
  conversationId: string
  userId: string
  environmentId: string
  toolName: string
  toolArgs: Record<string, unknown>
  reason: string | null
  status: string
  adminNote: string | null
  createdAt: string
  resolvedAt: string | null
}

const TIER_LABELS: Record<string, string> = {
  pending:  'Pending',
  approved: 'Approved',
  denied:   'Denied',
}

export default function ApprovalsPage() {
  const toast = useToast()
  const [requests, setRequests] = useState<ApprovalRequest[]>([])
  const [loading, setLoading]   = useState(true)
  const [acting, setActing]     = useState<string | null>(null)
  const [note, setNote]         = useState<Record<string, string>>({})
  const [filter, setFilter]     = useState<'pending' | 'all'>('pending')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = filter === 'all' ? '?status=all' : ''
      setRequests(await apiFetch<ApprovalRequest[]>(`/api/tool-approvals${params}`))
    } catch (e) {
      toast.error(`Failed to load approvals: ${errorMessage(e)}`)
    } finally { setLoading(false) }
  }, [filter])

  useEffect(() => { load() }, [load])

  const act = async (id: string, action: 'approve' | 'deny') => {
    setActing(id)
    try {
      await apiFetch(`/api/tool-approvals/${id}`, { method: 'POST', body: { action, adminNote: note[id] ?? '' } })
      await load()
    } catch (e) {
      toast.error(`Failed to ${action} request: ${errorMessage(e)}`)
    } finally { setActing(null) }
  }

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldAlert size={18} className="text-orange-400" />
          <h1 className="text-lg font-semibold text-text-primary">Tool Approval Requests</h1>
        </div>
        <div className="flex items-center gap-2">
          <select value={filter} onChange={e => setFilter(e.target.value as 'pending' | 'all')}
            className="px-2 py-1.5 text-xs bg-bg-raised border border-border-subtle rounded-sm text-text-primary focus:outline-hidden">
            <option value="pending">Pending only</option>
            <option value="all">All requests</option>
          </select>
          <button aria-label="Refresh" onClick={load} className="p-1.5 rounded-sm text-text-muted hover:text-text-primary border border-border-subtle transition-colors">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {requests.length === 0 ? (
        <div className="rounded-lg border border-border-subtle bg-bg-card px-4 py-12 text-center text-sm text-text-muted">
          {loading ? 'Loading…' : 'No approval requests'}
        </div>
      ) : (
        <div className="space-y-3">
          {requests.map(r => (
            <div key={r.id} className={`rounded-lg border-2 overflow-hidden ${
              r.status === 'pending'  ? 'border-orange-500 bg-orange-500/5' :
              r.status === 'approved' ? 'border-status-healthy/50 bg-status-healthy/5' :
              'border-border-subtle bg-bg-card'
            }`}>
              <div className="flex items-center gap-2 px-4 py-2 border-b border-inherit bg-black/5">
                {r.status === 'pending'  && <Clock size={12} className="text-orange-400" />}
                {r.status === 'approved' && <CheckCircle size={12} className="text-status-healthy" />}
                {r.status === 'denied'   && <XCircle size={12} className="text-status-error" />}
                <span className={`text-xs font-semibold ${
                  r.status === 'pending' ? 'text-orange-400' :
                  r.status === 'approved' ? 'text-status-healthy' : 'text-status-error'
                }`}>{TIER_LABELS[r.status]}</span>
                <span className="text-[10px] text-text-muted ml-auto">{new Date(r.createdAt).toLocaleString()}</span>
              </div>

              <div className="p-4 space-y-3">
                <div className="flex items-start gap-4">
                  <div className="flex-1 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <code className="text-sm font-medium text-accent">{r.toolName}</code>
                      <span className="text-[10px] text-text-muted px-1.5 py-0.5 rounded-sm bg-bg-raised border border-border-subtle">env: {r.environmentId.slice(0, 8)}</span>
                    </div>
                    {Object.keys(r.toolArgs ?? {}).length > 0 && (
                      <pre className="text-[11px] font-mono bg-bg-raised rounded-sm px-2 py-1.5 text-text-secondary border border-border-subtle overflow-x-auto">
                        {JSON.stringify(r.toolArgs, null, 2)}
                      </pre>
                    )}
                    {r.reason && <p className="text-xs text-text-muted">{r.reason}</p>}
                    {r.adminNote && <p className="text-xs text-text-secondary italic">Admin note: {r.adminNote}</p>}
                  </div>
                </div>

                {r.status === 'pending' && (
                  <div className="flex items-center gap-2 pt-1">
                    <Input
                      aria-label="Optional note to user"
                      value={note[r.id] ?? ''}
                      onChange={e => setNote(prev => ({ ...prev, [r.id]: e.target.value }))}
                      placeholder="Optional note to user…"
                      className="px-2 py-1.5 text-xs flex-1"
                    />
                    <button onClick={() => act(r.id, 'deny')} disabled={acting === r.id}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-sm text-xs font-medium text-status-error border border-status-error/30 hover:bg-status-error/10 transition-colors disabled:opacity-50">
                      <XCircle size={12} /> Deny
                    </button>
                    <button onClick={() => act(r.id, 'approve')} disabled={acting === r.id}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-sm text-xs font-medium bg-status-healthy/15 text-status-healthy border border-status-healthy/30 hover:bg-status-healthy/25 transition-colors disabled:opacity-50">
                      {acting === r.id ? <RefreshCw size={12} className="animate-spin" /> : <CheckCircle size={12} />}
                      Approve
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
