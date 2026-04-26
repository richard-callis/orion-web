'use client'
import { useEffect, useRef, useState } from 'react'
import mermaid from 'mermaid'

let initialized = false

// ── SVG sanitizer for XSS prevention ─────────────────────────────────────────
// Parses SVG string and removes dangerous elements/attributes before rendering.
// Prevents XSS when mermaid uses securityLevel: 'loose' (needed for interactivity).
function sanitizeSvg(svgString: string): Element | null {
  const parser = new DOMParser()
  const doc = parser.parseFromString(svgString, 'image/svg+xml')

  // Check for parser errors
  if (doc.documentElement.nodeName === 'parsererror') {
    return null
  }

  // Remove dangerous elements by traversing DOM safely
  const dangerousElements = doc.querySelectorAll(
    'script, object, embed, iframe, form, input, textarea, button, select, link, meta'
  )
  dangerousElements.forEach(el => el.remove())

  // Remove on* event handlers from all elements
  const allElements = doc.querySelectorAll('*')
  allElements.forEach(el => {
    Array.from(el.attributes).forEach(attr => {
      if (attr.name.toLowerCase().startsWith('on')) {
        el.removeAttribute(attr.name)
      }
    })

    // Neutralize dangerous URI schemes in href/src (javascript:, data:, vbscript:)
    const href = el.getAttribute('href')
    if (href) {
      const lowerHref = href.toLowerCase()
      if (lowerHref.startsWith('javascript:') || lowerHref.startsWith('data:') || lowerHref.startsWith('vbscript:')) {
        el.setAttribute('href', '#')
      }
    }
    const src = el.getAttribute('src')
    if (src) {
      const lowerSrc = src.toLowerCase()
      if (lowerSrc.startsWith('javascript:') || lowerSrc.startsWith('data:') || lowerSrc.startsWith('vbscript:')) {
        el.setAttribute('src', '#')
      }
    }
  })

  return doc.documentElement
}

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
        if (ref.current) {
          // Clear previous content
          ref.current.innerHTML = ''

          // Parse and sanitize SVG safely
          const sanitized = sanitizeSvg(svg)
          if (sanitized) {
            // Import the sanitized SVG into the document and append
            const imported = document.importNode(sanitized, true)
            ref.current.appendChild(imported)
          }
        }
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
