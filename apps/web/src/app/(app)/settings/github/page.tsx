'use client'

import { useEffect, useState } from 'react'

interface GithubStatus {
  connected: boolean
  githubUsername: string | null
}

export default function GithubSettingsPage() {
  const [status, setStatus] = useState<GithubStatus | null>(null)
  const [token, setToken] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function loadStatus() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/github/connect')
      if (!res.ok) throw new Error('Failed to load GitHub status')
      setStatus(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load status')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadStatus() }, [])

  async function connect(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/github/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? 'Failed to connect')
      setToken('')
      setStatus({ connected: true, githubUsername: data.githubUsername ?? null })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to connect')
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/github/connect', { method: 'DELETE' })
      if (!res.ok && res.status !== 204) throw new Error('Failed to disconnect')
      setStatus({ connected: false, githubUsername: null })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to disconnect')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="mb-2 text-2xl font-semibold">GitHub Integration</h1>
      <p className="mb-6 text-sm text-gray-500">
        Connect a GitHub Personal Access Token so your agents can read and write
        repositories, branches, and pull requests on your behalf. The token is
        encrypted at rest.
      </p>

      {error && (
        <div className="mb-4 rounded border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : status?.connected ? (
        <div className="rounded border border-gray-200 p-4">
          <p className="mb-4 text-sm">
            Connected as <span className="font-mono font-semibold">@{status.githubUsername}</span>
          </p>
          <button
            onClick={disconnect}
            disabled={busy}
            className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {busy ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </div>
      ) : (
        <form onSubmit={connect} className="rounded border border-gray-200 p-4">
          <label htmlFor="github-token" className="mb-2 block text-sm font-medium">
            Personal Access Token
          </label>
          <input
            id="github-token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ghp_… or github_pat_…"
            className="mb-3 w-full rounded border border-gray-300 px-3 py-2 font-mono text-sm"
          />
          <button
            type="submit"
            disabled={busy || !token.trim()}
            className="rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-black disabled:opacity-50"
          >
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </form>
      )}
    </div>
  )
}
