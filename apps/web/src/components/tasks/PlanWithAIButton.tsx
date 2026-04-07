'use client'
import { useState, useEffect, useRef } from 'react'
import { MessageSquare, ChevronRight, ChevronLeft } from 'lucide-react'

interface AppModel {
  id: string
  name: string
  provider: string
  builtIn: boolean
  modelId: string
  baseUrl?: string
  enabled: boolean
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  google:    'Google',
  ollama:    'Ollama',
  openai:    'OpenAI',
  custom:    'Custom',
}

export function PlanWithAIButton({ onSelect }: { onSelect: (modelId: string) => void }) {
  const [open, setOpen]                       = useState(false)
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null)
  const [models, setModels]                   = useState<AppModel[]>([])
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/api/models').then(r => r.json()).then(setModels).catch(() => {})
  }, [])

  useEffect(() => {
    if (!open) setSelectedProvider(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const providers = [...new Set(models.map(m => m.provider))]
  const providerModels = selectedProvider ? models.filter(m => m.provider === selectedProvider) : []

  const handleProviderClick = (provider: string) => {
    const ms = models.filter(m => m.provider === provider)
    if (ms.length === 1) {
      onSelect(ms[0].id)
      setOpen(false)
    } else {
      setSelectedProvider(provider)
    }
  }

  const handleModelClick = (modelId: string) => {
    onSelect(modelId)
    setOpen(false)
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded bg-accent text-white text-sm hover:bg-accent/80 transition-colors"
      >
        <MessageSquare size={14} /> Plan with AI
      </button>

      {open && (
        <div className="absolute bottom-full mb-1 left-0 right-0 rounded-lg border border-border-subtle bg-bg-sidebar shadow-2xl overflow-hidden z-50">
          {!selectedProvider ? (
            <>
              <p className="text-[10px] text-text-muted uppercase tracking-wide px-3 py-2 border-b border-border-subtle">Choose Provider</p>
              {providers.map(p => (
                <button
                  key={p}
                  onClick={() => handleProviderClick(p)}
                  className="w-full flex items-center justify-between px-3 py-2 text-sm text-text-primary hover:bg-accent/10 transition-colors"
                >
                  <span>{PROVIDER_LABELS[p] ?? p}</span>
                  <ChevronRight size={12} className="text-text-muted" />
                </button>
              ))}
            </>
          ) : (
            <>
              <button
                onClick={() => setSelectedProvider(null)}
                className="w-full flex items-center gap-1.5 px-3 py-2 text-[11px] text-text-muted hover:text-text-primary border-b border-border-subtle transition-colors"
              >
                <ChevronLeft size={11} />
                <span>{PROVIDER_LABELS[selectedProvider] ?? selectedProvider}</span>
              </button>
              {providerModels.map(m => (
                <button
                  key={m.id}
                  onClick={() => handleModelClick(m.id)}
                  className="w-full px-3 py-2 text-sm text-text-primary hover:bg-accent/10 text-left transition-colors"
                >
                  {m.name.replace(/^[^·]+·\s*/, '')}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
