import { Loader2 } from 'lucide-react'

export const card = 'bg-bg-surface border border-border-subtle rounded-xl'

export function Spinner() {
  return (
    <div className="px-4 py-10 flex justify-center" role="status" aria-label="Loading">
      <Loader2 size={20} className="animate-spin text-accent" aria-hidden />
    </div>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-8 text-center text-sm text-text-muted">{children}</div>
}

export function NoInvestigation({ what = 'this tab' }: { what?: string }) {
  return (
    <div className="px-4 py-10 text-center text-sm text-text-muted">
      No investigation linked — click &apos;Open Investigation&apos; to enable {what}.
    </div>
  )
}

export function CardHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 py-3 border-b border-border-subtle">
      <span className="text-sm font-medium text-text-primary">{children}</span>
    </div>
  )
}

export function verdictClass(verdict: string) {
  if (verdict === 'malicious') return 'bg-status-error/15 text-status-error'
  if (verdict === 'suspicious') return 'bg-status-warning/15 text-status-warning'
  if (verdict === 'benign') return 'bg-status-healthy/15 text-status-healthy'
  return 'bg-bg-raised text-text-muted'
}

export function severityText(sev: number) {
  return sev >= 80 ? 'text-status-error' : sev >= 50 ? 'text-status-warning' : 'text-text-muted'
}
