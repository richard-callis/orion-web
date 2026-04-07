'use client'
import { useState, useEffect, useRef } from 'react'

export default function LogsPage() {
  const [namespace, setNamespace] = useState('apps')
  const [pod, setPod] = useState('')
  const [lines, setLines] = useState<string[]>([])
  const [streaming, setStreaming] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines])

  const startStream = () => {
    if (!pod) return
    esRef.current?.close()
    setLines([])
    setStreaming(true)

    const es = new EventSource(`/api/k8s/pods/${namespace}/${pod}/logs`)
    esRef.current = es
    es.onmessage = (e) => setLines(prev => [...prev.slice(-500), e.data])
    es.onerror = () => { setStreaming(false); es.close() }
  }

  const stop = () => { esRef.current?.close(); setStreaming(false) }
  useEffect(() => () => esRef.current?.close(), [])

  return (
    <div className="absolute inset-0 flex flex-col p-4 lg:p-6 space-y-3">
      <div className="flex gap-2 flex-wrap">
        <input value={namespace} onChange={e => setNamespace(e.target.value)}
          placeholder="namespace" className="px-3 py-1.5 text-sm rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent w-36 font-mono" />
        <input value={pod} onChange={e => setPod(e.target.value)}
          placeholder="pod name" className="px-3 py-1.5 text-sm rounded border border-border-visible bg-bg-raised text-text-primary focus:outline-none focus:border-accent flex-1 font-mono" />
        <button onClick={streaming ? stop : startStream}
          className={`px-3 py-1.5 rounded text-sm font-medium ${streaming ? 'bg-status-error/20 text-status-error' : 'bg-accent text-white hover:bg-accent/80'}`}>
          {streaming ? 'Stop' : 'Stream Logs'}
        </button>
      </div>

      <div className="flex-1 rounded-lg border border-border-subtle bg-bg-card overflow-auto font-mono text-xs p-3">
        {lines.map((line, i) => (
          <div key={i} className="text-text-secondary leading-5 whitespace-pre-wrap">{line}</div>
        ))}
        {!lines.length && (
          <p className="text-text-muted">Enter a namespace and pod name, then click Stream Logs.</p>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
