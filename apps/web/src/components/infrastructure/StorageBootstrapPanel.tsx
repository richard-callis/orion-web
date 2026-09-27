'use client'

import { useState } from 'react'
import { Play, RefreshCw, Database } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { useToast } from '@/components/ui/Toast'
import { apiFetch, errorMessage } from '@/lib/api'
import { useClusterEnvironments } from './useClusterEnvironments'

type StorageType = 'longhorn' | 'ceph'

const STORAGE_OPTIONS: { value: StorageType; label: string; description: string }[] = [
  { value: 'longhorn', label: 'Longhorn',   description: 'Lightweight distributed block storage — ideal for small/medium clusters' },
  { value: 'ceph',     label: 'Rook-Ceph',  description: 'Production-grade distributed storage — requires 3+ nodes with raw disks' },
]

export default function StorageBootstrapPanel() {
  const toast = useToast()
  const { environments, envId, setEnvId } = useClusterEnvironments()
  const [storageType, setStorageType] = useState<StorageType>('longhorn')
  const [running, setRunning]         = useState(false)

  const run = async () => {
    if (!envId) return
    setRunning(true)
    try {
      const data = await apiFetch<{ jobId?: string }>('/api/storage/bootstrap', {
        method: 'POST',
        body: { environmentId: envId, storageType },
      })
      if (!data?.jobId) throw new Error('Bootstrap did not start (no job id returned)')
      toast.info('Bootstrap started — check the Jobs panel (briefcase icon) for live progress.')
    } catch (e) {
      toast.error(`Bootstrap failed to start: ${errorMessage(e)}`)
    } finally {
      setRunning(false)
    }
  }

  if (environments.length === 0) return null

  const selectedOption = STORAGE_OPTIONS.find(o => o.value === storageType)!

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Database size={13} className="text-accent" aria-hidden />
        <span className="text-sm font-semibold text-text-primary">Storage Bootstrap</span>
        <span className="text-xs text-text-muted">— deploy storage into a cluster environment</span>
      </div>

      <div className="flex gap-2" role="radiogroup" aria-label="Storage type">
        {STORAGE_OPTIONS.map(opt => (
          <button
            key={opt.value}
            role="radio"
            aria-checked={storageType === opt.value}
            onClick={() => { if (!running) setStorageType(opt.value) }}
            disabled={running}
            className={`flex-1 rounded-lg border px-3 py-2 text-left transition-colors ${
              storageType === opt.value
                ? 'border-accent bg-accent/10 text-text-primary'
                : 'border-border-subtle bg-bg-raised text-text-muted hover:border-accent/50 hover:text-text-primary'
            }`}
          >
            <div className="text-xs font-semibold">{opt.label}</div>
            <div className="text-[10px] mt-0.5 leading-tight">{opt.description}</div>
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <Select aria-label="Cluster environment" value={envId} onChange={e => setEnvId(e.target.value)}
          className="w-auto text-xs px-2 py-1.5" disabled={running}>
          <option value="">Select environment…</option>
          {environments.map(e => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </Select>

        <Button onClick={run} disabled={running || !envId}>
          {running
            ? <><RefreshCw size={11} className="animate-spin" aria-hidden /> Starting…</>
            : <><Play size={11} aria-hidden /> Bootstrap {selectedOption.label}</>
          }
        </Button>
      </div>
    </div>
  )
}
