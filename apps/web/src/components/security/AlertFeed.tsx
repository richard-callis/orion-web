'use client'

import { useState, useEffect, useRef } from 'react'
import { AlertTriangle, CheckCircle2, XCircle, Loader2, Shield, Globe, Database } from 'lucide-react'
import Link from 'next/link'
import { type NotifyMessage } from '@/lib/security/stream-utils'

const sourceIcons: Record<string, React.ElementType> = {
  crowdsec: Shield,
  ntopng: Globe,
  wazuh: Database,
  elk: Database,
  falco: Shield,
}

const sourceColors: Record<string, string> = {
  crowdsec: 'text-blue-400',
  ntopng: 'text-green-400',
  wazuh: 'text-orange-400',
  elk: 'text-purple-400',
  falco: 'text-red-400',
}

function SeverityBadge({ severity }: { severity: number }) {
  let cls = ''
  let icon = null
  if (severity >= 80) {
    cls = 'bg-red-500/20 text-red-400 border-red-500/30'
    icon = <XCircle size={10} />
  } else if (severity >= 50) {
    cls = 'bg-orange-500/20 text-orange-400 border-orange-500/30'
    icon = <AlertTriangle size={10} />
  } else if (severity >= 20) {
    cls = 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
    icon = <AlertTriangle size={10} />
  } else {
    cls = 'bg-green-500/20 text-green-400 border-green-500/30'
    icon = <CheckCircle2 size={10} />
  }

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border ${cls}`}>
      {icon}
      {severity}
    </span>
  )
}

export default function AlertFeed({ initialAlerts, compact }: { initialAlerts?: any[]; compact?: boolean }) {
  const [alerts, setAlerts] = useState(initialAlerts || [])
  const [selected, setSelected] = useState<string[]>([])
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    const source = new EventSource('/api/monitoring/security/stream?channel=events')

    source.onmessage = async (event) => {
      try {
        const frame = JSON.parse(event.data) as NotifyMessage
        if (frame.channel !== 'events' || !frame.payload?.id) return

        // Stream sends id-only frames — fetch the full event
        const res = await fetch(`/api/monitoring/security/alerts/${frame.payload.id}`)
        if (!res.ok || !mountedRef.current) return
        const { event: alertEvent } = await res.json()
        if (!alertEvent || !mountedRef.current) return

        setAlerts(prev => {
          // Deduplicate — stream may fire multiple times for the same event
          if (prev.some((a: any) => a.id === alertEvent.id)) return prev
          return [alertEvent, ...prev].slice(0, 100)
        })
      } catch {
        // Ignore malformed frames
      }
    }

    return () => source.close()
  }, [])

  async function ackSelected() {
    if (selected.length === 0) return
    await fetch('/api/monitoring/security/alerts/ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: selected }),
    })
    setAlerts(prev => prev.map((a: any) => selected.includes(a.id) ? { ...a, acknowledged: true } : a))
    setSelected([])
  }

  if (alerts.length === 0 && !initialAlerts) {
    return (
      <div className="p-8 text-center text-text-muted text-sm">
        <Loader2 size={20} className="animate-spin mx-auto mb-2 text-accent" />
        Connecting to security stream…
      </div>
    )
  }

  if (alerts.length === 0) {
    return (
      <div className="p-8 text-center text-text-muted text-sm">No alerts.</div>
    )
  }

  return (
    <div>
      {selected.length > 0 && (
        <div className="px-4 py-2 border-b border-border-subtle flex items-center justify-between bg-bg-raised">
          <span className="text-xs text-text-muted">{selected.length} selected</span>
          <button onClick={ackSelected} className="text-xs text-accent hover:underline">
            Acknowledge selected
          </button>
        </div>
      )}

      <div className="divide-y divide-border-subtle">
        {alerts.map((alert: any) => {
          const Icon = sourceIcons[alert.source] || Shield
          return (
            <div
              key={alert.id}
              className={`px-4 py-3 flex items-start gap-3 transition-colors ${
                selected.includes(alert.id) ? 'bg-accent/5' : 'hover:bg-bg-raised'
              } ${alert.acknowledged ? 'opacity-50' : ''}`}
            >
              <input
                type="checkbox"
                checked={selected.includes(alert.id)}
                onChange={() => setSelected(prev =>
                  prev.includes(alert.id) ? prev.filter((id: string) => id !== alert.id) : [...prev, alert.id]
                )}
                className="mt-1 accent-accent"
              />
              <Icon size={14} className={`flex-shrink-0 mt-0.5 ${sourceColors[alert.source] || 'text-text-muted'}`} />
              <Link href={`/security/alerts/${alert.id}`} className="flex-1 min-w-0 group">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-text-primary truncate group-hover:text-accent transition-colors">{alert.title}</span>
                  <SeverityBadge severity={alert.severity} />
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[10px] text-text-muted">{alert.source}</span>
                  <span className="text-[10px] text-text-muted">·</span>
                  <span className="text-[10px] text-text-muted">{new Date(alert.createdAt).toLocaleString()}</span>
                </div>
                {!compact && alert.description && (
                  <p className="text-xs text-text-muted mt-1 truncate">{alert.description}</p>
                )}
              </Link>
            </div>
          )
        })}
      </div>
    </div>
  )
}
