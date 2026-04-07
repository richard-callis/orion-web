'use client'
import { useEffect, useRef, useState } from 'react'
import mermaid from 'mermaid'

let initialized = false

export function MermaidBlock({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!initialized) {
      mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' })
      initialized = true
    }

    const id = `mermaid-${Math.random().toString(36).slice(2)}`
    setError(null)
    mermaid.render(id, code)
      .then(({ svg }) => {
        if (ref.current) ref.current.innerHTML = svg
      })
      .catch(err => {
        setError(err?.message ?? 'Failed to render diagram')
      })
  }, [code])

  if (error) {
    return (
      <pre className="bg-bg-raised border border-status-error/30 text-status-error text-xs p-3 rounded mb-3 overflow-auto">
        Mermaid error: {error}
      </pre>
    )
  }

  return <div ref={ref} className="my-4 flex justify-center [&_svg]:max-w-full" />
}
