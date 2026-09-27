import type { Mermaid } from 'mermaid'

// Browser-only rendering path for MermaidBlock, kept separate from the React
// component so e2e/specs/mermaid.spec.mjs can bundle and exercise exactly this code.

// securityLevel 'strict' disables HTML labels and click handlers in diagrams.
export const MERMAID_CONFIG = { startOnLoad: false, theme: 'dark', securityLevel: 'strict' } as const

// mermaid is several MB; load it only when a diagram is actually rendered.
let mermaidPromise: Promise<Mermaid> | null = null
export function loadMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize(MERMAID_CONFIG)
    return mermaid
  })
  return mermaidPromise
}

// ── SVG sanitizer for XSS prevention ─────────────────────────────────────────
// Parses SVG string and removes dangerous elements/attributes before rendering.
// Now redundant with securityLevel: 'strict' (which disables HTML labels and click
// handlers in Mermaid diagrams), but kept as defense-in-depth.
export function sanitizeSvg(svgString: string): Element | null {
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

/** Render mermaid source to a sanitized SVG element (null if the SVG fails to parse). */
export async function renderMermaidSvg(code: string): Promise<Element | null> {
  const mermaid = await loadMermaid()
  const id = `mermaid-${Math.random().toString(36).slice(2)}`
  const { svg } = await mermaid.render(id, code)
  return sanitizeSvg(svg)
}
