'use client'
import { useEffect, useState } from 'react'

interface Health {
  k8s: boolean
  db: boolean
  claude: boolean
  externalModels?: Record<string, boolean>
}

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
  anthropic: 'Claude',
  ollama:    'Ollama',
  openai:    'OpenAI',
  google:    'Gemini',
  custom:    'Custom',
}

export function StatusBar() {
  const [health, setHealth] = useState<Health | null>(null)
  const [models, setModels] = useState<AppModel[]>([])
  const [domain, setDomain] = useState<string>('')

  useEffect(() => {
    fetch('/api/setup/status')
      .then(r => r.json())
      .then(d => { if (d.internalDomain) setDomain(d.internalDomain) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    const check = () =>
      Promise.all([
        fetch('/api/health').then(r => r.json()).catch(() => null),
        fetch('/api/models').then(r => r.json()).catch(() => []),
      ]).then(([h, m]) => {
        setHealth(h)
        setModels(Array.isArray(m) ? m : [])
      })
    check()
    const t = setInterval(check, 30_000)
    return () => clearInterval(t)
  }, [])

  const dot = (ok: boolean | undefined) => (
    <span className={`inline-block w-2 h-2 rounded-full status-pulse ${ok ? 'bg-status-healthy' : ok === false ? 'bg-status-error' : 'bg-text-muted'}`} />
  )

  const providerHealth = (provider: string): boolean | undefined => {
    if (!health) return undefined
    if (provider === 'anthropic') return health.claude
    // External: healthy if all models for this provider are healthy
    const ext = models.filter(m => m.provider === provider && !m.builtIn)
    if (ext.length === 0) return undefined
    return ext.every(m => health.externalModels?.[m.id] === true)
  }

  const uniqueProviders = [...new Set(models.map(m => m.provider))]

  return (
    <div className="hidden md:flex items-center gap-4 px-4 py-1.5 border-t border-border-subtle bg-bg-sidebar text-xs text-text-muted font-mono">
      <span className="flex items-center gap-1.5">{dot(health?.k8s)} K8s</span>
      <span className="flex items-center gap-1.5">{dot(health?.db)} DB</span>
      {uniqueProviders.map(provider => (
        <span key={provider} className="flex items-center gap-1.5">
          {dot(providerHealth(provider))} {PROVIDER_LABELS[provider] ?? provider}
        </span>
      ))}
      {uniqueProviders.length === 0 && (
        <span className="flex items-center gap-1.5">{dot(health?.claude)} Claude</span>
      )}
      {domain && <span className="ml-auto opacity-40">{domain}</span>}
    </div>
  )
}
