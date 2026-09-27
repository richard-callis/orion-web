'use client'
import { useEffect, useRef, useState } from 'react'
import { renderMermaidSvg } from './mermaid-render'

export function MermaidBlock({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    renderMermaidSvg(code)
      .then(sanitized => {
        if (!cancelled && ref.current) {
          // Clear previous content
          ref.current.innerHTML = ''
          if (sanitized) {
            // Import the sanitized SVG into the document and append
            const imported = document.importNode(sanitized, true)
            ref.current.appendChild(imported)
          }
        }
      })
      .catch(err => {
        if (!cancelled) setError(err?.message ?? 'Failed to render diagram')
      })
    return () => { cancelled = true }
  }, [code])

  if (error) {
    return (
      <pre className="bg-bg-raised border border-status-error/30 text-status-error text-xs p-3 rounded-sm mb-3 overflow-auto">
        Mermaid error: {error}
      </pre>
    )
  }

  return <div ref={ref} className="my-4 flex justify-center [&_svg]:max-w-full" />
}
