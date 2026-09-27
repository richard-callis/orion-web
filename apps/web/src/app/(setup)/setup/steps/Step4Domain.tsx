'use client'

import { useEffect, useState, type FormEvent } from 'react'
import useSWR from 'swr'
import { Input } from '@/components/ui/Input'
import { ContinueLabel, ErrorBanner, Field, PrimaryButton, Required, StepHeading, postSetup, rememberStep, setupFieldClass } from './shared'

export function Step4Domain({ onNext }: { onNext: () => void }) {
  const [internalDomain, setInternalDomain] = useState('')
  const [publicDomain, setPublicDomain] = useState('')
  const [managementIp, setManagementIp] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Pre-fill the management IP detected at bootstrap.
  const { data: bootstrap } = useSWR<{ managementIp?: string }>('/api/setup/bootstrap-config', { revalidateOnFocus: false })
  useEffect(() => {
    if (bootstrap?.managementIp) setManagementIp(ip => ip || bootstrap.managementIp!)
  }, [bootstrap])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const res = await postSetup('/api/setup/domain', { internalDomain, publicDomain, managementIp }, 'Failed to save domain configuration')
    setLoading(false)
    if (!res.ok) { setError(res.error); return }
    rememberStep(5)
    onNext()
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <StepHeading title="Domain configuration">
        ORION will configure CoreDNS as the authoritative DNS server for your internal domain.
      </StepHeading>

      {error && <ErrorBanner message={error} />}

      <div className="space-y-4">
        <Field label={<>Internal domain <Required /></>} hint="Used for internal services (e.g. orion.homelab.local)">
          {id => <Input id={id} type="text" value={internalDomain} onChange={e => setInternalDomain(e.target.value)}
            className={setupFieldClass} placeholder="homelab.local" required autoFocus />}
        </Field>
        <Field label={<>Public domain <span className="text-text-muted font-normal">(optional)</span></>}
          hint="Used for externally accessible services via Cloudflare or your DNS provider">
          {id => <Input id={id} type="text" value={publicDomain} onChange={e => setPublicDomain(e.target.value)}
            className={setupFieldClass} placeholder="example.com" />}
        </Field>
        <Field label={<>Management node IP <Required /></>} hint="Static IP of this node — DNS records will point here">
          {id => <Input id={id} type="text" value={managementIp} onChange={e => setManagementIp(e.target.value)}
            className={setupFieldClass} placeholder="192.168.1.10" required />}
        </Field>
      </div>

      <div className="text-[11px] text-text-muted bg-bg-raised border border-border-subtle rounded-lg px-3 py-2">
        CoreDNS will reload automatically within 30 seconds of saving.
      </div>

      <PrimaryButton type="submit" disabled={loading || !internalDomain || !managementIp} loading={loading} loadingLabel="Saving…">
        <ContinueLabel />
      </PrimaryButton>
    </form>
  )
}
