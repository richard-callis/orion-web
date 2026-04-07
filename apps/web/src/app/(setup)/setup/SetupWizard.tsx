'use client'

import { useState, useEffect, FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Check, Copy, Loader2, Eye, EyeOff, ChevronRight, Shield } from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

type Step = 1 | 2 | 3 | 4 | 5

interface VaultResult {
  keys: string[]
  rootToken: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const inputCls = 'w-full px-3 py-2 text-sm bg-bg-raised border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-accent placeholder:text-text-muted'
const labelCls = 'block text-xs font-medium text-text-muted mb-1.5'

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 text-xs text-status-error bg-status-error/10 border border-status-error/20 rounded-lg px-3 py-2.5">
      <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
      <span>{message}</span>
    </div>
  )
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button onClick={copy} className="flex-shrink-0 p-1 rounded text-text-muted hover:text-text-primary transition-colors">
      {copied ? <Check size={12} className="text-status-success" /> : <Copy size={12} />}
    </button>
  )
}

// ── Progress indicator ────────────────────────────────────────────────────────

const STEPS = ['Token', 'Admin', 'Domain', 'AI Provider', 'Vault']

function ProgressBar({ current }: { current: Step }) {
  return (
    <div className="flex items-center gap-0 mb-8">
      {STEPS.map((label, i) => {
        const stepNum = (i + 1) as Step
        const done = stepNum < current
        const active = stepNum === current
        return (
          <div key={label} className="flex items-center">
            <div className="flex flex-col items-center gap-1">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold transition-colors
                ${done ? 'bg-accent text-white' : active ? 'border-2 border-accent text-accent' : 'border border-border-subtle text-text-muted'}`}>
                {done ? <Check size={12} /> : stepNum}
              </div>
              <span className={`text-[10px] font-medium ${active ? 'text-text-primary' : 'text-text-muted'}`}>
                {label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div className={`h-px w-8 mx-1 mb-4 transition-colors ${done ? 'bg-accent' : 'bg-border-subtle'}`} />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Step 1: Token verification ────────────────────────────────────────────────

function Step1Token({ onNext }: { onNext: () => void }) {
  const [token, setToken] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const res = await fetch('/api/setup/verify-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    setLoading(false)
    if (!res.ok) {
      const data = await res.json()
      setError(data.error ?? 'Verification failed')
    } else {
      sessionStorage.setItem('orion_setup_step', '2')
      onNext()
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-text-primary mb-1">Enter setup token</h2>
        <p className="text-xs text-text-muted">
          Run <code className="bg-bg-raised px-1 py-0.5 rounded text-[11px]">docker compose logs orion | grep SETUP_TOKEN</code> to find your token.
        </p>
      </div>

      {error && <ErrorBanner message={error} />}

      <div>
        <label className={labelCls}>Setup token</label>
        <div className="relative">
          <input
            type={show ? 'text' : 'password'}
            value={token}
            onChange={e => setToken(e.target.value)}
            className={inputCls + ' pr-10 font-mono text-xs'}
            placeholder="Paste token here"
            autoFocus
            required
          />
          <button type="button" onClick={() => setShow(s => !s)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary">
            {show ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </div>

      <button type="submit" disabled={loading || !token}
        className="w-full flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-60 transition-colors">
        {loading && <Loader2 size={14} className="animate-spin" />}
        {loading ? 'Verifying…' : <>Verify <ChevronRight size={14} /></>}
      </button>
    </form>
  )
}

// ── Step 2: Admin account ─────────────────────────────────────────────────────

function Step2Admin({ onNext }: { onNext: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (password !== confirm) { setError('Passwords do not match'); return }
    if (password.length < 10) { setError('Password must be at least 10 characters'); return }
    setLoading(true)
    const res = await fetch('/api/setup/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    setLoading(false)
    if (!res.ok) {
      const data = await res.json()
      setError(data.error ?? 'Failed to create admin account')
    } else {
      sessionStorage.setItem('orion_setup_step', '3')
      onNext()
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-text-primary mb-1">Create admin account</h2>
        <p className="text-xs text-text-muted">This will be the primary administrator for ORION.</p>
      </div>

      {error && <ErrorBanner message={error} />}

      <div className="space-y-4">
        <div>
          <label className={labelCls}>Username</label>
          <input type="text" value={username} onChange={e => setUsername(e.target.value)}
            className={inputCls} autoComplete="username" required autoFocus />
        </div>
        <div>
          <label className={labelCls}>Password</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)}
            className={inputCls} autoComplete="new-password" required />
          <p className="text-[11px] text-text-muted mt-1">Minimum 10 characters</p>
        </div>
        <div>
          <label className={labelCls}>Confirm password</label>
          <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
            className={inputCls} autoComplete="new-password" required />
        </div>
      </div>

      <button type="submit" disabled={loading || !username || !password || !confirm}
        className="w-full flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-60 transition-colors">
        {loading && <Loader2 size={14} className="animate-spin" />}
        {loading ? 'Creating…' : <>Continue <ChevronRight size={14} /></>}
      </button>
    </form>
  )
}

// ── Step 3: Domain configuration ──────────────────────────────────────────────

function Step3Domain({ onNext }: { onNext: () => void }) {
  const [internalDomain, setInternalDomain] = useState('')
  const [publicDomain, setPublicDomain] = useState('')
  const [managementIp, setManagementIp] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetch('/api/setup/bootstrap-config')
      .then(r => r.json())
      .then(d => { if (d.managementIp) setManagementIp(d.managementIp) })
      .catch(() => {})
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const res = await fetch('/api/setup/domain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ internalDomain, publicDomain, managementIp }),
    })
    setLoading(false)
    if (!res.ok) {
      const data = await res.json()
      setError(data.error ?? 'Failed to save domain configuration')
    } else {
      sessionStorage.setItem('orion_setup_step', '4')
      onNext()
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-text-primary mb-1">Domain configuration</h2>
        <p className="text-xs text-text-muted">ORION will configure CoreDNS as the authoritative DNS server for your internal domain.</p>
      </div>

      {error && <ErrorBanner message={error} />}

      <div className="space-y-4">
        <div>
          <label className={labelCls}>Internal domain <span className="text-status-error">*</span></label>
          <input type="text" value={internalDomain} onChange={e => setInternalDomain(e.target.value)}
            className={inputCls} placeholder="homelab.local" required autoFocus />
          <p className="text-[11px] text-text-muted mt-1">Used for internal services (e.g. orion.homelab.local)</p>
        </div>
        <div>
          <label className={labelCls}>Public domain <span className="text-text-muted font-normal">(optional)</span></label>
          <input type="text" value={publicDomain} onChange={e => setPublicDomain(e.target.value)}
            className={inputCls} placeholder="example.com" />
          <p className="text-[11px] text-text-muted mt-1">Used for externally accessible services via Cloudflare or your DNS provider</p>
        </div>
        <div>
          <label className={labelCls}>Management node IP <span className="text-status-error">*</span></label>
          <input type="text" value={managementIp} onChange={e => setManagementIp(e.target.value)}
            className={inputCls} placeholder="192.168.1.10" required />
          <p className="text-[11px] text-text-muted mt-1">Static IP of this node — DNS records will point here</p>
        </div>
      </div>

      <div className="text-[11px] text-text-muted bg-bg-raised border border-border-subtle rounded-lg px-3 py-2">
        CoreDNS will reload automatically within 30 seconds of saving.
      </div>

      <button type="submit" disabled={loading || !internalDomain || !managementIp}
        className="w-full flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-60 transition-colors">
        {loading && <Loader2 size={14} className="animate-spin" />}
        {loading ? 'Saving…' : <>Continue <ChevronRight size={14} /></>}
      </button>
    </form>
  )
}

// ── Step 4: AI provider ───────────────────────────────────────────────────────

const PROVIDERS = [
  { value: 'anthropic', label: 'Anthropic', defaultUrl: 'https://api.anthropic.com', defaultModel: 'claude-opus-4-6' },
  { value: 'openai', label: 'OpenAI', defaultUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o' },
  { value: 'ollama', label: 'Ollama (local)', defaultUrl: 'http://ollama:11434', defaultModel: 'llama3' },
  { value: 'custom', label: 'Custom (OpenAI-compatible)', defaultUrl: '', defaultModel: '' },
]

function Step4AI({ onNext }: { onNext: () => void }) {
  const [provider, setProvider] = useState('anthropic')
  const [name, setName] = useState('Default')
  const [baseUrl, setBaseUrl] = useState('https://api.anthropic.com')
  const [apiKey, setApiKey] = useState('')
  const [modelId, setModelId] = useState('claude-opus-4-6')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  function selectProvider(val: string) {
    setProvider(val)
    const p = PROVIDERS.find(p => p.value === val)
    if (p) { setBaseUrl(p.defaultUrl); setModelId(p.defaultModel) }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const res = await fetch('/api/setup/ai-provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, provider, baseUrl, apiKey, modelId }),
    })
    setLoading(false)
    if (!res.ok) {
      const data = await res.json()
      setError(data.error ?? 'Failed to save AI provider')
    } else {
      sessionStorage.setItem('orion_setup_step', '5')
      onNext()
    }
  }

  async function skip() {
    await fetch('/api/setup/ai-provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skip: true }),
    })
    sessionStorage.setItem('orion_setup_step', '5')
    onNext()
  }

  const needsApiKey = provider !== 'ollama'

  return (
    <form onSubmit={submit} className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-text-primary mb-1">AI provider</h2>
        <p className="text-xs text-text-muted">Configure the AI model ORION agents will use. You can change this later.</p>
      </div>

      {error && <ErrorBanner message={error} />}

      <div className="space-y-4">
        <div>
          <label className={labelCls}>Provider</label>
          <select value={provider} onChange={e => selectProvider(e.target.value)}
            className={inputCls}>
            {PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Display name</label>
          <input type="text" value={name} onChange={e => setName(e.target.value)} className={inputCls} required />
        </div>
        <div>
          <label className={labelCls}>Base URL</label>
          <input type="text" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} className={inputCls} required />
        </div>
        <div>
          <label className={labelCls}>Model ID</label>
          <input type="text" value={modelId} onChange={e => setModelId(e.target.value)} className={inputCls} required />
        </div>
        {needsApiKey && (
          <div>
            <label className={labelCls}>API key</label>
            <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} className={inputCls} />
          </div>
        )}
      </div>

      <div className="flex gap-3">
        <button type="button" onClick={skip}
          className="flex-1 py-2 text-sm text-text-muted border border-border-subtle rounded-lg hover:border-text-muted transition-colors">
          Skip for now
        </button>
        <button type="submit" disabled={loading}
          className="flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-60 transition-colors">
          {loading && <Loader2 size={14} className="animate-spin" />}
          {loading ? 'Saving…' : <>Continue <ChevronRight size={14} /></>}
        </button>
      </div>
    </form>
  )
}

// ── Step 5: Vault initialization ──────────────────────────────────────────────

function Step5Vault({ onComplete }: { onComplete: () => void }) {
  const [vaultResult, setVaultResult] = useState<VaultResult | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [completing, setCompleting] = useState(false)

  async function initVault() {
    setError('')
    setLoading(true)
    const res = await fetch('/api/setup/vault', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    setLoading(false)
    const data = await res.json()
    if (!res.ok) {
      if (data.error === 'vault_unavailable') {
        setError('Vault is not reachable. Ensure it is running, then try again. You can also skip and initialize Vault later.')
      } else if (data.error === 'vault_already_initialized') {
        setError('Vault is already initialized. Proceed to complete setup.')
      } else {
        setError(data.message ?? 'Vault initialization failed')
      }
    } else {
      setVaultResult({ keys: data.keys, rootToken: data.rootToken })
    }
  }

  async function complete() {
    setCompleting(true)
    await fetch('/api/setup/complete', { method: 'POST' })
    onComplete()
  }

  async function skip() {
    await fetch('/api/setup/vault', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skip: true }),
    })
    setCompleting(true)
    await fetch('/api/setup/complete', { method: 'POST' })
    onComplete()
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-text-primary mb-1">Initialize Vault</h2>
        <p className="text-xs text-text-muted">ORION uses Vault to store secrets for all managed environments. Initialize it now or skip and do it later.</p>
      </div>

      {error && <ErrorBanner message={error} />}

      {!vaultResult ? (
        <div className="flex gap-3">
          <button onClick={skip} disabled={completing}
            className="flex-1 py-2 text-sm text-text-muted border border-border-subtle rounded-lg hover:border-text-muted transition-colors disabled:opacity-60">
            Skip for now
          </button>
          <button onClick={initVault} disabled={loading}
            className="flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-60 transition-colors">
            {loading && <Loader2 size={14} className="animate-spin" />}
            {loading ? 'Initializing…' : 'Initialize Vault'}
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Key display */}
          <div className="rounded-lg border border-status-warning/40 bg-status-warning/5 p-4 space-y-3">
            <div className="flex items-center gap-2 text-status-warning text-xs font-semibold">
              <Shield size={13} />
              Save these keys — they will never be shown again
            </div>
            <div className="space-y-1.5">
              {vaultResult.keys.map((key, i) => (
                <div key={i} className="flex items-center gap-2 font-mono text-[11px]">
                  <span className="text-text-muted w-14 flex-shrink-0">Key {i + 1}:</span>
                  <span className="text-text-primary break-all flex-1">{key}</span>
                  <CopyButton value={key} />
                </div>
              ))}
              <div className="flex items-center gap-2 font-mono text-[11px] pt-2 border-t border-border-subtle">
                <span className="text-text-muted w-14 flex-shrink-0">Root:</span>
                <span className="text-text-primary break-all flex-1">{vaultResult.rootToken}</span>
                <CopyButton value={vaultResult.rootToken} />
              </div>
            </div>
          </div>

          <label className="flex items-start gap-2.5 cursor-pointer">
            <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}
              className="mt-0.5 accent-accent" />
            <span className="text-xs text-text-muted">I have securely saved all unseal keys and the root token</span>
          </label>

          <button onClick={complete} disabled={!confirmed || completing}
            className="w-full flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-60 transition-colors">
            {completing && <Loader2 size={14} className="animate-spin" />}
            {completing ? 'Finishing…' : <><Check size={14} /> Complete setup</>}
          </button>
        </div>
      )}
    </div>
  )
}

// ── Main wizard ───────────────────────────────────────────────────────────────

export default function SetupWizard() {
  const router = useRouter()
  const [step, setStep] = useState<Step>(1)

  // Restore step from sessionStorage on page load
  useEffect(() => {
    const saved = sessionStorage.getItem('orion_setup_step')
    if (saved) setStep(parseInt(saved) as Step)
  }, [])

  function next() { setStep(s => (s < 5 ? (s + 1) as Step : s)) }

  function handleComplete() {
    sessionStorage.removeItem('orion_setup_step')
    router.push('/login')
  }

  return (
    <div className="w-full max-w-lg space-y-2">
      <div className="text-center mb-6">
        <div className="text-2xl font-bold tracking-tight text-text-primary">ORION</div>
        <div className="text-xs text-text-muted mt-0.5">First-run setup</div>
      </div>

      <div className="flex justify-center">
        <ProgressBar current={step} />
      </div>

      <div className="bg-bg-surface border border-border-subtle rounded-xl p-6">
        {step === 1 && <Step1Token onNext={next} />}
        {step === 2 && <Step2Admin onNext={next} />}
        {step === 3 && <Step3Domain onNext={next} />}
        {step === 4 && <Step4AI onNext={next} />}
        {step === 5 && <Step5Vault onComplete={handleComplete} />}
      </div>

      <p className="text-center text-[11px] text-text-muted">
        Step {step} of 5 — <span className="text-text-primary">{STEPS[step - 1]}</span>
      </p>
    </div>
  )
}
