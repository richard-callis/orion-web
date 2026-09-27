import { cva, type VariantProps } from 'class-variance-authority'
import { AlertTriangle, CheckCircle, CheckCircle2, Clock, RefreshCw, XCircle } from 'lucide-react'
import { cn } from './cn'

export const badgeVariants = cva('inline-flex items-center gap-1 rounded font-medium', {
  variants: {
    tone: {
      green: 'bg-green-500/20 text-green-400 border-green-500/30',
      red: 'bg-red-500/20 text-red-400 border-red-500/30',
      orange: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
      yellow: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
      blue: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
      purple: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
      gray: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
      muted: 'bg-bg-raised text-text-muted border-border-subtle',
    },
    size: {
      xs: 'text-[10px] px-2 py-0.5',
      sm: 'text-xs px-1.5 py-0.5',
      md: 'text-xs px-2 py-0.5',
    },
    bordered: { true: 'border', false: '' },
  },
  defaultVariants: { tone: 'muted', size: 'md', bordered: false },
})

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['tone']>

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, size, bordered, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone, size, bordered }), className)} {...props} />
}

// ── Run / job status ──────────────────────────────────────────────────────────

const RUN_STATUS_TONE: Record<string, BadgeTone> = {
  completed: 'green',
  succeeded: 'green',
  success: 'green',
  failed: 'red',
  error: 'red',
  running: 'blue',
  pending: 'yellow',
  queued: 'yellow',
}

export function runStatusTone(status: string): BadgeTone {
  return RUN_STATUS_TONE[status] ?? 'muted'
}

/**
 * Status of a job, run, or eval. `variant="inline"` renders an icon + label
 * without a background, for dense lists.
 */
export function RunStatusBadge({
  status,
  variant = 'pill',
  label,
  className,
}: {
  status: string
  variant?: 'pill' | 'inline'
  /** Override the displayed text (defaults to the status). */
  label?: string
  className?: string
}) {
  if (variant === 'inline') {
    const map: Record<string, { cls: string; icon: React.ReactNode; text: string }> = {
      completed: { cls: 'text-status-healthy', icon: <CheckCircle size={11} />, text: 'done' },
      failed: { cls: 'text-status-error', icon: <XCircle size={11} />, text: 'failed' },
      running: { cls: 'text-status-warning', icon: <RefreshCw size={11} className="animate-spin" />, text: 'running' },
    }
    const m = map[status] ?? { cls: 'text-text-muted', icon: <Clock size={11} />, text: status }
    return (
      <span className={cn('flex items-center gap-1 text-[10px] font-medium', m.cls, className)}>
        {m.icon}
        {label ?? m.text}
      </span>
    )
  }
  return (
    <Badge tone={runStatusTone(status)} className={className}>
      {label ?? status}
    </Badge>
  )
}

// ── Security severity (0-100) ─────────────────────────────────────────────────

export function severityLevel(severity: number): { tone: BadgeTone; label: string } {
  if (severity >= 80) return { tone: 'red', label: 'Critical' }
  if (severity >= 50) return { tone: 'orange', label: 'High' }
  if (severity >= 20) return { tone: 'yellow', label: 'Medium' }
  return { tone: 'green', label: 'Low' }
}

export function SeverityBadge({ severity, showLabel = false }: { severity: number; showLabel?: boolean }) {
  const { tone, label } = severityLevel(severity)
  const Icon = severity >= 20 ? (severity >= 80 ? XCircle : AlertTriangle) : CheckCircle2
  return (
    <Badge tone={tone} size="xs" bordered>
      <Icon size={10} aria-hidden="true" />
      {severity}
      {showLabel && ` ${label}`}
    </Badge>
  )
}
