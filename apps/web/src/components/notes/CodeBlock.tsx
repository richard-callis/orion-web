'use client'
import { useRef, useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { MermaidBlock } from './MermaidBlock'

export function CodeBlock({ children }: { children: React.ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)

  // Detect mermaid before rendering
  const child = Array.isArray(children) ? children[0] : children
  if (child && typeof child === 'object' && 'props' in child) {
    const { className, children: code } = (child as React.ReactElement<{ className?: string; children?: React.ReactNode }>).props
    if (className?.includes('language-mermaid')) {
      return <MermaidBlock code={String(code).trim()} />
    }
  }

  const copy = () => {
    const text = preRef.current?.textContent ?? ''
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {})
  }

  return (
    <div className="relative group mb-3">
      <pre ref={preRef} className="bg-bg-raised rounded overflow-auto text-sm font-mono leading-relaxed [&_.hljs]:bg-transparent [&_.hljs]:p-4 [&_code:not(.hljs)]:p-4 [&_code:not(.hljs)]:block">
        {children}
      </pre>
      <button
        onClick={copy}
        className="absolute top-2 right-2 p-1.5 rounded text-text-muted hover:text-text-primary bg-bg-sidebar/90 opacity-0 group-hover:opacity-100 transition-all"
        title="Copy"
      >
        {copied ? <Check size={11} className="text-green-400" /> : <Copy size={11} />}
      </button>
    </div>
  )
}
