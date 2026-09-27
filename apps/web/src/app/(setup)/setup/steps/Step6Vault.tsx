'use client'

import { useState } from 'react'
import { Check, Shield } from 'lucide-react'
import { CopyButton, ErrorBanner, PrimaryButton, SkipButton, StepHeading, postSetup } from './shared'

interface VaultResult { keys: string[]; rootToken: string }

export function Step6Vault({ onComplete }: { onComplete: () => void }) {
  const [vaultResult, setVaultResult] = useState<VaultResult | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [completing, setCompleting] = useState(false)

  async function initVault() {
    setError('')
    setLoading(true)
    const res = await postSetup<VaultResult>('/api/setup/vault', {}, 'Vault initialization failed')
    setLoading(false)
    if (res.ok) {
      setVaultResult({ keys: res.data.keys, rootToken: res.data.rootToken })
    } else if (res.error === 'vault_unavailable') {
      setError('Vault is not reachable. Ensure it is running, then try again. You can also skip and initialize Vault later.')
    } else if (res.error === 'vault_already_initialized') {
      setError('Vault is already initialized. Proceed to complete setup.')
    } else {
      setError(typeof res.body?.message === 'string' ? res.body.message : 'Vault initialization failed')
    }
  }

  async function complete() {
    setCompleting(true)
    await postSetup('/api/setup/complete')
    onComplete()
  }

  async function skip() {
    await postSetup('/api/setup/vault', { skip: true })
    await complete()
  }

  return (
    <div className="space-y-5">
      <StepHeading title="Initialize Vault">
        ORION uses Vault to store secrets for all managed environments. Initialize it now or skip and do it later.
      </StepHeading>

      {error && <ErrorBanner message={error} />}

      {!vaultResult ? (
        <div className="flex gap-3">
          <SkipButton onClick={skip} disabled={completing} />
          <PrimaryButton onClick={initVault} disabled={loading} loading={loading} loadingLabel="Initializing…" className="flex-1 w-auto">
            Initialize Vault
          </PrimaryButton>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-lg border border-status-warning/40 bg-status-warning/5 p-4 space-y-3">
            <div className="flex items-center gap-2 text-status-warning text-xs font-semibold">
              <Shield size={13} />
              Save these keys — they will never be shown again
            </div>
            <div className="space-y-1.5">
              {vaultResult.keys.map((key, i) => (
                <div key={i} className="flex items-center gap-2 font-mono text-[11px]">
                  <span className="text-text-muted w-14 shrink-0">Key {i + 1}:</span>
                  <span className="text-text-primary break-all flex-1">{key}</span>
                  <CopyButton value={key} label={`Copy unseal key ${i + 1}`} />
                </div>
              ))}
              <div className="flex items-center gap-2 font-mono text-[11px] pt-2 border-t border-border-subtle">
                <span className="text-text-muted w-14 shrink-0">Root:</span>
                <span className="text-text-primary break-all flex-1">{vaultResult.rootToken}</span>
                <CopyButton value={vaultResult.rootToken} label="Copy root token" />
              </div>
            </div>
          </div>

          <label className="flex items-start gap-2.5 cursor-pointer">
            <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}
              className="mt-0.5 accent-accent" />
            <span className="text-xs text-text-muted">I have securely saved all unseal keys and the root token</span>
          </label>

          <PrimaryButton onClick={complete} disabled={!confirmed || completing} loading={completing} loadingLabel="Finishing…">
            <Check size={14} /> Complete setup
          </PrimaryButton>
        </div>
      )}
    </div>
  )
}
