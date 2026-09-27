'use client'

import { useState } from 'react'
import { PrimaryButton, RadioCard, StepHeading, postSetup } from './shared'

type Monitoring = 'none' | 'basic' | 'full'

const OPTIONS: { value: Monitoring; title: string; description: string }[] = [
  { value: 'none',  title: 'None',               description: 'Skip monitoring setup. You can enable it later in settings.' },
  { value: 'basic', title: 'Metrics & Traffic',  description: 'Deploy VictoriaMetrics + Grafana + ntopng for metrics and network traffic monitoring.' },
  { value: 'full',  title: 'Full Observability', description: 'Metrics + ELK stack + Elastiflow + all security tools (CrowdSec, Wazuh, ntopng).' },
]

export function Step7Monitoring({ onNext }: { onNext: () => void }) {
  const [selected, setSelected] = useState<Monitoring>('none')
  const [loading, setLoading] = useState(false)

  async function submit() {
    setLoading(true)
    await postSetup('/api/setup/complete', { monitoring: selected })
    setLoading(false)
    onNext()
  }

  return (
    <div className="space-y-5">
      <StepHeading title="Monitoring & Observability">Choose what monitoring stack to deploy to your cluster.</StepHeading>

      <fieldset className="space-y-2">
        <legend className="sr-only">Monitoring stack</legend>
        {OPTIONS.map(o => (
          <RadioCard key={o.value} name="monitoring" checked={selected === o.value} onChange={() => setSelected(o.value)} className="items-start py-3">
            <div>
              <div className="text-sm font-medium text-text-primary">{o.title}</div>
              <div className="text-[11px] text-text-muted">{o.description}</div>
            </div>
          </RadioCard>
        ))}
      </fieldset>

      <PrimaryButton onClick={submit} disabled={loading} loading={loading} loadingLabel="Completing…">
        Complete setup
      </PrimaryButton>
    </div>
  )
}
