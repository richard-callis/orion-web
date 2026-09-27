'use client'

import { useState, type FormEvent } from 'react'
import { Eye, EyeOff, ChevronRight } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { IconButton } from '@/components/ui/Button'
import { ErrorBanner, Field, PrimaryButton, postSetup, rememberStep, setupFieldClass } from './shared'

export function Step1Token({ onNext }: { onNext: () => void }) {
  const [token, setToken] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const res = await postSetup('/api/setup/verify-token', { token }, 'Verification failed')
    setLoading(false)
    if (!res.ok) { setError(res.error); return }
    rememberStep(2)
    onNext()
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-text-primary mb-1">Enter setup token</h2>
        <p className="text-xs text-text-muted">
          Run <code className="bg-bg-raised px-1 py-0.5 rounded-sm text-[11px]">docker compose logs orion | grep SETUP_TOKEN</code> to find your token.
        </p>
      </div>

      {error && <ErrorBanner message={error} />}

      <Field label="Setup token">
        {id => (
          <div className="relative">
            <Input
              id={id}
              type={show ? 'text' : 'password'}
              value={token}
              onChange={e => setToken(e.target.value)}
              className={`${setupFieldClass} pr-10 font-mono text-xs`}
              placeholder="Paste token here"
              autoFocus
              required
            />
            <IconButton
              label={show ? 'Hide token' : 'Show token'}
              onClick={() => setShow(s => !s)}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-0"
            >
              {show ? <EyeOff size={14} /> : <Eye size={14} />}
            </IconButton>
          </div>
        )}
      </Field>

      <PrimaryButton type="submit" disabled={loading || !token} loading={loading} loadingLabel="Verifying…">
        Verify <ChevronRight size={14} />
      </PrimaryButton>
    </form>
  )
}
