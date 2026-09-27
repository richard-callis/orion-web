'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { Loader2, GitBranch } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Input } from '@/components/ui/Input'
import { ContinueLabel, ErrorBanner, Field, PrimaryButton, RadioCard, Required, SkipButton, StepHeading, postSetup, rememberStep, setupFieldClass } from './shared'

type GitProviderType = 'gitea-bundled' | 'gitea' | 'github' | 'gitlab'

const GIT_PROVIDERS: { value: GitProviderType; label: string; description: string }[] = [
  { value: 'gitea-bundled', label: 'Gitea (included)', description: 'Deploy Gitea alongside ORION — best for a fresh homelab setup' },
  { value: 'gitea',         label: 'Gitea (external)', description: 'Connect to an existing Gitea instance' },
  { value: 'github',        label: 'GitHub',           description: 'Use GitHub repos for GitOps (public or private)' },
  { value: 'gitlab',        label: 'GitLab',           description: 'Use GitLab (gitlab.com or self-hosted)' },
]

interface BootstrapConfig {
  giteaBundled?: boolean
  giteaAdminToken?: string
  giteaAdminUser?: string
  giteaAdminPassword?: string
}

export function Step3Git({ onNext }: { onNext: () => void }) {
  const [providerType, setProviderType] = useState<GitProviderType>('gitea-bundled')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [adminUser, setAdminUser] = useState('')
  const [adminPassword, setAdminPassword] = useState('')
  const [org, setOrg] = useState('orion')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [autoSubmitting, setAutoSubmitting] = useState(false)

  // On mount: fetch bootstrap config — if bundled Gitea is detected, auto-submit
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let d: BootstrapConfig
      try { d = await apiFetch<BootstrapConfig>('/api/setup/bootstrap-config') } catch { return }
      if (cancelled || !d.giteaBundled) return
      setProviderType('gitea-bundled')
      setAutoSubmitting(true)
      // Prefer pre-generated token; fall back to user+password
      const body: Record<string, string> = { type: 'gitea-bundled', org: 'orion' }
      if (d.giteaAdminToken) body.token = d.giteaAdminToken
      else {
        body.adminUser     = d.giteaAdminUser ?? ''
        body.adminPassword = d.giteaAdminPassword ?? ''
      }
      const res = await postSetup('/api/setup/git-provider', body, 'Failed to configure bundled Gitea')
      if (cancelled) return
      setAutoSubmitting(false)
      if (res.ok) { rememberStep(4); onNext() }
      else setError(res.error)
    })()
    return () => { cancelled = true }
  }, [onNext])

  const isBundled  = providerType === 'gitea-bundled'
  const needsUrl   = providerType === 'gitea' || providerType === 'gitlab'
  const needsToken = !isBundled

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const body: Record<string, string> = { type: providerType, org }
    if (isBundled) {
      body.adminUser     = adminUser
      body.adminPassword = adminPassword
    } else {
      body.token = token
      if (needsUrl) body.url = url
    }
    const res = await postSetup('/api/setup/git-provider', body, 'Failed to configure git provider')
    setLoading(false)
    if (!res.ok) { setError(res.error); return }
    rememberStep(4)
    onNext()
  }

  async function skip() {
    await postSetup('/api/setup/git-provider', { skip: true })
    rememberStep(4)
    onNext()
  }

  if (autoSubmitting) {
    return (
      <div className="space-y-4">
        <StepHeading title="Git provider" />
        <div className="flex items-center gap-3 text-sm text-text-muted" role="status">
          <Loader2 size={16} className="animate-spin text-accent shrink-0" />
          Configuring bundled Gitea…
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <StepHeading title="Git provider">
        ORION uses Git to manage infrastructure changes — every cluster change is a PR with full audit trail.
      </StepHeading>

      {error && <ErrorBanner message={error} />}

      <fieldset className="space-y-1.5">
        <legend className="sr-only">Git provider</legend>
        {GIT_PROVIDERS.map(p => (
          <RadioCard key={p.value} name="gitProvider" checked={providerType === p.value}
            onChange={() => { setProviderType(p.value); setUrl(''); setToken('') }}>
            <div className="min-w-0">
              <div className="text-sm font-medium text-text-primary flex items-center gap-1.5">
                <GitBranch size={11} className="text-text-muted shrink-0" />
                {p.label}
              </div>
              <div className="text-[10px] text-text-muted truncate">{p.description}</div>
            </div>
          </RadioCard>
        ))}
      </fieldset>

      <div className="space-y-4 pt-1">
        {/* Bundled Gitea: need admin credentials to bootstrap the API token */}
        {isBundled && (
          <>
            <div className="text-[11px] text-text-muted bg-bg-raised border border-border-subtle rounded-lg px-3 py-2.5">
              Gitea is included in the ORION stack. Enter the admin credentials you want to use —
              ORION will configure Gitea automatically.
            </div>
            <Field label={<>Gitea admin username <Required /></>}>
              {id => <Input id={id} type="text" value={adminUser} onChange={e => setAdminUser(e.target.value)}
                className={setupFieldClass} placeholder="admin" required autoFocus />}
            </Field>
            <Field label={<>Gitea admin password <Required /></>}>
              {id => <Input id={id} type="password" value={adminPassword} onChange={e => setAdminPassword(e.target.value)}
                className={setupFieldClass} required />}
            </Field>
          </>
        )}

        {/* URL for self-hosted providers */}
        {needsUrl && (
          <Field label={<>{providerType === 'gitlab' ? 'GitLab URL' : 'Gitea URL'} <Required /></>}>
            {id => <Input id={id} type="url" value={url} onChange={e => setUrl(e.target.value)}
              className={setupFieldClass}
              placeholder={providerType === 'gitlab' ? 'https://gitlab.com' : 'https://gitea.example.com'}
              required />}
          </Field>
        )}

        {/* API token for external providers */}
        {needsToken && (
          <Field
            label={<>{providerType === 'github' ? 'Personal access token' : 'API token'} <Required /></>}
            hint={providerType === 'github' ? 'Needs: repo, admin:repo_hook'
              : providerType === 'gitlab' ? 'Needs: api scope (personal access token or group token)' : undefined}
          >
            {id => <Input id={id} type="password" value={token} onChange={e => setToken(e.target.value)}
              className={`${setupFieldClass} font-mono text-xs`}
              placeholder={providerType === 'github' ? 'ghp_…' : 'Paste token'}
              required />}
          </Field>
        )}

        {/* Org / namespace */}
        <Field
          label={<>{providerType === 'gitlab' ? 'Namespace / group' : 'Organisation or username'} <Required /></>}
          hint="Environment repos will be created under this owner"
        >
          {id => <Input id={id} type="text" value={org} onChange={e => setOrg(e.target.value)}
            className={setupFieldClass}
            placeholder={providerType === 'github' ? 'my-org' : providerType === 'gitlab' ? 'my-group or username' : 'orion'}
            required />}
        </Field>
      </div>

      <div className="flex gap-3">
        <SkipButton onClick={skip} />
        <PrimaryButton type="submit" disabled={loading} loading={loading} loadingLabel="Connecting…" className="flex-1 w-auto">
          <ContinueLabel />
        </PrimaryButton>
      </div>
    </form>
  )
}
