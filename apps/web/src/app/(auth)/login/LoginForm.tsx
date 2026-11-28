'use client'

import { useState, useEffect, FormEvent } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Input } from '@/components/ui/Input'

export default function LoginForm({ authentikEnabled = false }: { authentikEnabled?: boolean }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  // After an OIDC round-trip `next` carries the real target (see handleAuthentik).
  const oidcDone = searchParams.get('oidc') === 'done'
  const rawCallbackUrl = (oidcDone ? searchParams.get('next') : searchParams.get('callbackUrl')) ?? '/'
  function isSafeCallbackUrl(url: string): boolean {
    // Must start with / but not // (protocol-relative URLs would redirect off-origin)
    return url.startsWith('/') && !url.startsWith('//')
  }
  const callbackUrl = isSafeCallbackUrl(rawCallbackUrl) ? rawCallbackUrl : '/'

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // The session cookie is SameSite=Strict, so it is not sent on the server-redirect chain that
  // starts at Authentik. Hop client-side (same-site navigation) so the cookie is attached.
  useEffect(() => {
    if (oidcDone) window.location.replace(callbackUrl)
  }, [oidcDone, callbackUrl])

  function handleAuthentik() {
    void signIn('authentik', { callbackUrl: `/login?oidc=done&next=${encodeURIComponent(callbackUrl)}` })
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    const result = await signIn('credentials', {
      username,
      password,
      redirect: false,
    })

    setLoading(false)

    if (result?.error) {
      setError('Invalid username or password')
    } else {
      router.push(callbackUrl)
    }
  }


  return (
    <div className="w-full max-w-sm space-y-6">
      {/* Logo / title */}
      <div className="text-center space-y-1">
        <div className="text-2xl font-bold tracking-tight text-text-primary">ORION</div>
        <div className="text-xs text-text-muted">Operations & Resource Infrastructure Orchestration Node</div>
      </div>

      <div className="bg-bg-surface border border-border-subtle rounded-xl p-6 space-y-5">
        <h1 className="text-sm font-semibold text-text-primary">Sign in</h1>

        {error && (
          <div className="flex items-center gap-2 text-xs text-status-error bg-status-error/10 border border-status-error/20 rounded-lg px-3 py-2">
            <AlertTriangle size={14} className="shrink-0" />
            {error}
          </div>
        )}

        {authentikEnabled && (
          <>
            <button
              type="button"
              onClick={handleAuthentik}
              className="w-full px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors"
            >
              Sign in with Authentik
            </button>
            <div className="text-center text-xs text-text-muted">or use a local account</div>
          </>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="login-username" className="text-xs text-text-muted font-medium">Username</label>
            <Input
              id="login-username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={e => setUsername(e.target.value)}
              required
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="login-password" className="text-xs text-text-muted font-medium">Password</label>
            <Input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-60 transition-colors"
          >
            {loading && <Loader2 size={14} className="animate-spin" />}
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
