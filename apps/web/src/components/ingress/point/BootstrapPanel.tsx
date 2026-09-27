'use client'

import { useState } from 'react'
import { RefreshCw, Play } from 'lucide-react'
import { btnPrimary } from '../styles'

export function BootstrapPanel({ pointId, onDone }: { pointId: string; onDone: (status: string) => void }) {
  const [running, setRunning]   = useState(false)
  const [notice, setNotice]     = useState<{ text: string; ok: boolean } | null>(null)

  const run = async () => {
    setRunning(true); setNotice(null)
    try {
      const res = await fetch(`/api/ingress/points/${pointId}/bootstrap`, { method: 'POST' })
      const data = await res.json() as { jobId?: string; error?: string }
      if (!res.ok || !data.jobId) {
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }
      setNotice({ text: 'Bootstrap started — check the Jobs panel for live progress.', ok: true })
      // Optimistically mark as bootstrapped so the UI reflects the attempt
      onDone('bootstrapped')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setNotice({ text: msg, ok: false })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button onClick={run} disabled={running} className={btnPrimary}>
          {running
            ? <><RefreshCw size={11} className="animate-spin" /> Starting…</>
            : <><Play size={11} /> Bootstrap</>
          }
        </button>
        {notice && (
          <span className={`text-xs ${notice.ok ? 'text-status-healthy' : 'text-status-error'}`}>
            {notice.text}
          </span>
        )}
      </div>
    </div>
  )
}

// ── Middleware row ─────────────────────────────────────────────────────────────
