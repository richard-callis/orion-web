'use client'

import { useState, type FormEvent } from 'react'
import { Input } from '@/components/ui/Input'
import { ContinueLabel, ErrorBanner, Field, PrimaryButton, StepHeading, postSetup, rememberStep, setupFieldClass } from './shared'

export function Step2Admin({ onNext }: { onNext: () => void }) {
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
    const res = await postSetup('/api/setup/admin', { username, password }, 'Failed to create admin account')
    setLoading(false)
    if (!res.ok) { setError(res.error); return }
    rememberStep(3)
    onNext()
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <StepHeading title="Create admin account">This will be the primary administrator for ORION.</StepHeading>

      {error && <ErrorBanner message={error} />}

      <div className="space-y-4">
        <Field label="Username">
          {id => <Input id={id} type="text" value={username} onChange={e => setUsername(e.target.value)}
            className={setupFieldClass} autoComplete="username" required autoFocus />}
        </Field>
        <Field label="Password" hint="Minimum 10 characters">
          {id => <Input id={id} type="password" value={password} onChange={e => setPassword(e.target.value)}
            className={setupFieldClass} autoComplete="new-password" required />}
        </Field>
        <Field label="Confirm password">
          {id => <Input id={id} type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
            className={setupFieldClass} autoComplete="new-password" required />}
        </Field>
      </div>

      <PrimaryButton type="submit" disabled={loading || !username || !password || !confirm} loading={loading} loadingLabel="Creating…">
        <ContinueLabel />
      </PrimaryButton>
    </form>
  )
}
