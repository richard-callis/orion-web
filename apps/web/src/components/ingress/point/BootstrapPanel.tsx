'use client'

import { useState } from 'react'
import { RefreshCw, Play } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { apiFetch, errorMessage } from '@/lib/api'

export function BootstrapPanel({ pointId, onDone }: { pointId: string; onDone: (status: string) => void }) {
  const [running, setRunning]   = useState(false)
  const [notice, setNotice]     = useState<{ text: string; ok: boolean } | null>(null)

  const run = async () => {
    setRunning(true); setNotice(null)
    try {
      const data = await apiFetch<{ jobId?: string }>(`/api/ingress/points/${pointId}/bootstrap`, { method: 'POST' })
      if (!data?.jobId) throw new Error('Bootstrap did not start (no job id returned)')
      setNotice({ text: 'Bootstrap started — check the Jobs panel for live progress.', ok: true })
      // Optimistically mark as bootstrapped so the UI reflects the attempt
      onDone('bootstrapped')
    } catch (e) {
      setNotice({ text: errorMessage(e), ok: false })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button onClick={run} disabled={running}>
          {running
            ? <><RefreshCw size={11} className="animate-spin" /> Starting…</>
            : <><Play size={11} /> Bootstrap</>
          }
        </Button>
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
