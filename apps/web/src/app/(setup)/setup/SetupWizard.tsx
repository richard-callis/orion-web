'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ProgressBar, STEPS, type Step } from './steps/shared'
import { Step1Token } from './steps/Step1Token'
import { Step2Admin } from './steps/Step2Admin'
import { Step3Git } from './steps/Step3Git'
import { Step4Domain } from './steps/Step4Domain'
import { Step5AI } from './steps/Step5AI'
import { Step6Vault } from './steps/Step6Vault'
import { Step7Monitoring } from './steps/Step7Monitoring'

export default function SetupWizard() {
  const router = useRouter()
  const [step, setStep] = useState<Step>(1)

  useEffect(() => {
    let saved: string | null = null
    try { saved = sessionStorage.getItem('orion_setup_step') } catch { /* storage unavailable */ }
    const n = saved ? parseInt(saved, 10) : NaN
    if (n >= 1 && n <= STEPS.length) setStep(n as Step)
  }, [])

  // Stable so steps that auto-advance from an effect (Step3Git) don't re-run it.
  const next = useCallback(() => { setStep(s => (s < 7 ? (s + 1) as Step : s)) }, [])

  const handleComplete = useCallback(() => {
    try { sessionStorage.removeItem('orion_setup_step') } catch { /* storage unavailable */ }
    router.push('/login')
  }, [router])

  return (
    <div className="w-full max-w-lg flex flex-col max-h-screen py-4">
      <div className="text-center mb-4 flex-shrink-0">
        <div className="text-2xl font-bold tracking-tight text-text-primary">ORION</div>
        <div className="text-xs text-text-muted mt-0.5">First-run setup</div>
      </div>

      <div className="flex justify-center flex-shrink-0">
        <ProgressBar current={step} />
      </div>

      <div className="bg-bg-surface border border-border-subtle rounded-xl overflow-y-auto flex-1 min-h-0">
        <div className="p-6">
          {step === 1 && <Step1Token onNext={next} />}
          {step === 2 && <Step2Admin onNext={next} />}
          {step === 3 && <Step3Git onNext={next} />}
          {step === 4 && <Step4Domain onNext={next} />}
          {step === 5 && <Step5AI onNext={next} />}
          {step === 6 && <Step6Vault onComplete={handleComplete} />}
          {step === 7 && <Step7Monitoring onNext={handleComplete} />}
        </div>
      </div>

      <p className="text-center text-[11px] text-text-muted mt-2 flex-shrink-0">
        Step {step} of {STEPS.length} — <span className="text-text-primary">{STEPS[step - 1]}</span>
      </p>
    </div>
  )
}
