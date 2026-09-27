'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useEventSource } from '@/hooks/useSSE'

const MAX_LINES = 500

export function LogsTab() {
  const id = useId()
  const [namespace, setNamespace] = useState('apps')
  const [pod, setPod] = useState('')
  const [lines, setLines] = useState<Array<{ id: number; text: string }>>([])
  // Non-null while streaming; clearing it closes the EventSource.
  const [streamUrl, setStreamUrl] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)
  const nextLineId = useRef(0)

  useEventSource(
    streamUrl,
    data => setLines(prev => [...prev.slice(-MAX_LINES), { id: nextLineId.current++, text: data }]),
    { onError: () => setStreamUrl(null) },
  )

  // Follow the tail only while the user hasn't scrolled up; set scrollTop
  // directly so the page itself doesn't scroll.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !nearBottomRef.current) return
    const frame = requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
    return () => cancelAnimationFrame(frame)
  }, [lines])

  const start = () => {
    if (!pod) return
    setLines([])
    nearBottomRef.current = true
    setStreamUrl(`/api/k8s/pods/${encodeURIComponent(namespace)}/${encodeURIComponent(pod)}/logs`)
  }

  const streaming = streamUrl !== null

  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap">
        <label htmlFor={`${id}-ns`} className="sr-only">Namespace</label>
        <Input id={`${id}-ns`} value={namespace} onChange={e => setNamespace(e.target.value)}
          placeholder="namespace" className="w-36 font-mono" />
        <label htmlFor={`${id}-pod`} className="sr-only">Pod name</label>
        <Input id={`${id}-pod`} value={pod} onChange={e => setPod(e.target.value)}
          placeholder="pod name" className="flex-1 w-auto font-mono" />
        <Button variant={streaming ? 'danger' : 'primary'} size="md" onClick={streaming ? () => setStreamUrl(null) : start} disabled={!streaming && !pod}>
          {streaming ? 'Stop' : 'Stream Logs'}
        </Button>
      </div>

      <div
        ref={scrollRef}
        role="log"
        aria-live="off"
        aria-label="Pod log output"
        onScroll={e => {
          const el = e.currentTarget
          nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
        }}
        className="rounded-lg border border-border-subtle bg-bg-card overflow-auto font-mono text-xs p-3 min-h-[300px] max-h-[60vh]"
      >
        {lines.map(line => (
          <div key={line.id} className="text-text-secondary leading-5 whitespace-pre-wrap">{line.text}</div>
        ))}
        {!lines.length && (
          <p className="text-text-muted">Enter a namespace and pod name, then click Stream Logs.</p>
        )}
      </div>
    </div>
  )
}
