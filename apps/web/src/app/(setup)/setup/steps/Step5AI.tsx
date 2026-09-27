'use client'

import { useState, type FormEvent } from 'react'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { ContinueLabel, ErrorBanner, Field, PrimaryButton, SkipButton, StepHeading, postSetup, rememberStep, setupFieldClass } from './shared'

const AI_PROVIDERS = [
  { value: 'anthropic', label: 'Anthropic', defaultUrl: 'https://api.anthropic.com', defaultModel: 'claude-opus-4-6' },
  { value: 'openai', label: 'OpenAI', defaultUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o' },
  { value: 'ollama', label: 'Ollama (local)', defaultUrl: 'http://ollama:11434', defaultModel: 'llama3' },
  { value: 'custom', label: 'Custom (OpenAI-compatible)', defaultUrl: '', defaultModel: '' },
]

export function Step5AI({ onNext }: { onNext: () => void }) {
  const [provider, setProvider] = useState('anthropic')
  const [name, setName] = useState('Default')
  const [baseUrl, setBaseUrl] = useState('https://api.anthropic.com')
  const [apiKey, setApiKey] = useState('')
  const [modelId, setModelId] = useState('claude-opus-4-6')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  function selectProvider(val: string) {
    setProvider(val)
    const p = AI_PROVIDERS.find(p => p.value === val)
    if (p) { setBaseUrl(p.defaultUrl); setModelId(p.defaultModel) }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const res = await postSetup('/api/setup/ai-provider', { name, provider, baseUrl, apiKey, modelId }, 'Failed to save AI provider')
    setLoading(false)
    if (!res.ok) { setError(res.error); return }
    rememberStep(6)
    onNext()
  }

  async function skip() {
    await postSetup('/api/setup/ai-provider', { skip: true })
    rememberStep(6)
    onNext()
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <StepHeading title="AI provider">Configure the AI model ORION agents will use. You can change this later.</StepHeading>

      {error && <ErrorBanner message={error} />}

      <div className="space-y-4">
        <Field label="Provider">
          {id => (
            <Select id={id} value={provider} onChange={e => selectProvider(e.target.value)} className={setupFieldClass}>
              {AI_PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Display name">
          {id => <Input id={id} type="text" value={name} onChange={e => setName(e.target.value)} className={setupFieldClass} required />}
        </Field>
        <Field label="Base URL">
          {id => <Input id={id} type="text" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} className={setupFieldClass} required />}
        </Field>
        <Field label="Model ID">
          {id => <Input id={id} type="text" value={modelId} onChange={e => setModelId(e.target.value)} className={setupFieldClass} required />}
        </Field>
        {provider !== 'ollama' && (
          <Field label="API key">
            {id => <Input id={id} type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} className={setupFieldClass} />}
          </Field>
        )}
      </div>

      <div className="flex gap-3">
        <SkipButton onClick={skip} />
        <PrimaryButton type="submit" disabled={loading} loading={loading} loadingLabel="Saving…" className="flex-1 w-auto">
          <ContinueLabel />
        </PrimaryButton>
      </div>
    </form>
  )
}
