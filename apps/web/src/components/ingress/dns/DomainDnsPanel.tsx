'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Plus, Pencil, Trash2, RefreshCw, AlertCircle, Terminal, DatabaseZap } from 'lucide-react'
import { DnsBootstrapPanel } from './DnsBootstrapPanel'
import { DnsRecordModal } from './DnsRecordModal'
import type { DnsRecord, Domain, Env } from '../types'
import { Button } from '@/components/ui/Button'
import { apiFetch, errorMessage } from '@/lib/api'
import { useToast } from '@/components/ui/Toast'

export function DomainDnsPanel({ domain, environments, ingressPointIp, onDomainChange }: {
  domain: Domain
  environments: Env[]
  ingressPointIp: string | null
  onDomainChange: (updates: Partial<Domain>) => void
}) {
  const recordsKey = `/api/ingress/domains/${domain.id}/dns/records`
  const { data, isLoading: loading, mutate } = useSWR<DnsRecord[]>(recordsKey, { revalidateOnFocus: false })
  const records = Array.isArray(data) ? data : []
  const load = () => { void mutate() }
  const toast = useToast()
  const [modal, setModal]       = useState<{ open: boolean; record?: DnsRecord }>({ open: false })
  const [deleting, setDeleting] = useState<string | null>(null)
  const [syncing, setSyncing]   = useState(false)
  const [dnsTab, setDnsTab]     = useState<'records' | 'bootstrap'>(
    domain.coreDnsStatus === 'bootstrapped' ? 'records' : 'bootstrap'
  )

  const hasWildcard = records.some(r => r.enabled && r.hostnames.some(h => h === `*.${domain.name}`))

  const del = async (record: DnsRecord) => {
    setDeleting(record.id)
    try {
      await apiFetch(`${recordsKey}/${record.id}`, { method: 'DELETE' })
      await mutate(rs => rs?.filter(r => r.id !== record.id), { revalidate: false })
    } catch (e) {
      toast.error(`Failed to delete record: ${errorMessage(e)}`)
    } finally { setDeleting(null) }
  }

  const sync = async () => {
    setSyncing(true)
    try {
      await apiFetch(`/api/ingress/domains/${domain.id}/dns/sync`, { method: 'POST' })
      toast.success('DNS records synced to CoreDNS')
    } catch (e) {
      toast.error(`Sync failed: ${errorMessage(e)}`)
    } finally { setSyncing(false) }
  }

  const dnsBtnCls = (t: 'records' | 'bootstrap') =>
    `flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded transition-colors ${
      dnsTab === t ? 'bg-accent/10 text-accent' : 'text-text-muted hover:text-text-primary'
    }`

  return (
    <div className="space-y-3 min-w-0 overflow-hidden">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button className={dnsBtnCls('records')} onClick={() => setDnsTab('records')}>
            <DatabaseZap size={10} /> Records
            {domain.coreDnsStatus === 'bootstrapped' && <span className="ml-1 w-1.5 h-1.5 rounded-full bg-status-healthy inline-block" />}
          </button>
          <button className={dnsBtnCls('bootstrap')} onClick={() => setDnsTab('bootstrap')}>
            <Terminal size={10} /> Bootstrap
          </button>
        </div>
        {dnsTab === 'records' && (
          <div className="flex items-center gap-1.5">
            {domain.coreDnsStatus === 'bootstrapped' && (
              <Button onClick={sync} disabled={syncing} variant="secondary" title="Force sync to CoreDNS">
                <RefreshCw size={10} className={syncing ? 'animate-spin' : ''} /> Sync
              </Button>
            )}
            <Button onClick={() => setModal({ open: true })}>
              <Plus size={11} /> Add Record
            </Button>
          </div>
        )}
      </div>

      {dnsTab === 'bootstrap' ? (
        <DnsBootstrapPanel domain={domain} environments={environments} onDone={updates => { onDomainChange(updates); setDnsTab('records') }} />
      ) : (
        <>
          <div className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border ${hasWildcard ? 'border-status-healthy/30 bg-status-healthy/5 text-status-healthy' : 'border-status-warning/30 bg-status-warning/5 text-status-warning'}`}>
            <DatabaseZap size={11} className="flex-shrink-0" />
            {hasWildcard ? <>Wildcard <code className="font-mono">*.{domain.name}</code> active</> : <>No wildcard — add <code className="font-mono">*.{domain.name}</code> pointing to your Traefik IP</>}
          </div>
          {domain.coreDnsStatus !== 'bootstrapped' && (
            <div className="flex items-center gap-2 text-xs px-2.5 py-2 rounded-lg border border-status-warning/30 bg-status-warning/5 text-status-warning">
              <AlertCircle size={11} className="flex-shrink-0" />
              CoreDNS not bootstrapped — records saved but not served yet.
            </div>
          )}
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-text-muted py-2"><RefreshCw size={12} className="animate-spin" /> Loading…</div>
          ) : records.length === 0 ? (
            <p className="text-xs text-text-muted italic py-1">No DNS records yet.</p>
          ) : (
            <div className="space-y-1.5">
              {records.map(rec => (
                <div key={rec.id} className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors min-w-0 ${rec.enabled ? 'border-border-subtle bg-bg-surface hover:bg-bg-raised' : 'border-border-subtle/50 bg-bg-canvas opacity-60'}`}>
                  <code className="text-[11px] font-mono text-accent w-28 flex-shrink-0">{rec.ip}</code>
                  <div className="flex-1 flex flex-wrap gap-1 min-w-0 overflow-hidden">
                    {rec.hostnames.map(h => (
                      <span key={h} className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-border-subtle bg-bg-canvas text-text-secondary">{h}</span>
                    ))}
                  </div>
                  {rec.comment && <span className="text-[10px] text-text-muted truncate max-w-[100px]">{rec.comment}</span>}
                  <button aria-label={`Edit record ${rec.ip}`} onClick={() => setModal({ open: true, record: rec })} className="text-text-muted hover:text-text-primary transition-colors flex-shrink-0"><Pencil size={11} /></button>
                  <button aria-label={`Delete record ${rec.ip}`} onClick={() => del(rec)} disabled={deleting === rec.id} className="text-text-muted hover:text-status-error transition-colors flex-shrink-0">
                    {deleting === rec.id ? <RefreshCw size={11} className="animate-spin" /> : <Trash2 size={11} />}
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {modal.open && (
        <DnsRecordModal
          domain={domain}
          initial={modal.record}
          suggestedIp={ingressPointIp ?? domain.coreDnsIp}
          onSave={load}
          onClose={() => setModal({ open: false })}
        />
      )}
    </div>
  )
}

// ── Domain panel ──────────────────────────────────────────────────────────────
