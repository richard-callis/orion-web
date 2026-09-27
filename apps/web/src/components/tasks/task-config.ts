import type { Task, Feature, Epic } from '@/types/tasks'

export const AGENT_COLORS = [
  'bg-blue-500', 'bg-purple-500', 'bg-emerald-500', 'bg-orange-500',
  'bg-pink-500', 'bg-cyan-500', 'bg-yellow-500', 'bg-red-500',
]

// Known status config — label + top-border colour. Any status not listed here
// gets a sensible default so new statuses appear automatically without code changes.
export const STATUS_CONFIG: Record<string, { label: string; border: string }> = {
  pending:            { label: 'Backlog',        border: 'border-t-border-visible' },
  in_progress:        { label: 'In Progress',    border: 'border-t-accent' },
  pending_validation: { label: 'Waiting for QA', border: 'border-t-status-warning' },
  done:               { label: 'Done',           border: 'border-t-status-healthy' },
  failed:             { label: 'Failed',         border: 'border-t-status-error' },
  critical:           { label: 'Critical',       border: 'border-t-status-error' },
}

// Preferred display order — known statuses first, unknowns appended after.
export const STATUS_ORDER = ['pending', 'in_progress', 'pending_validation', 'done', 'failed', 'critical']

export function statusConfig(status: string): { label: string; border: string } {
  return STATUS_CONFIG[status] ?? {
    label: status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    border: 'border-t-border-visible',
  }
}

export const priorityConfig: Record<string, { label: string; color: string; dot: string }> = {
  critical: { label: 'Critical', color: 'text-status-error',   dot: 'bg-status-error'   },
  high:     { label: 'High',     color: 'text-status-warning', dot: 'bg-status-warning' },
  medium:   { label: 'Medium',   color: 'text-accent',         dot: 'bg-accent'         },
  low:      { label: 'Low',      color: 'text-text-muted',     dot: 'bg-border-visible' },
}

const RISK_KEYWORDS: { pattern: RegExp; hint: string }[] = [
  { pattern: /\b(delete|drop|truncate|destroy|wipe|purge)\b/i, hint: 'Destructive operation — make sure a backup or rollback plan exists.' },
  { pattern: /\b(production|prod|live)\b/i, hint: 'Targets production — verify with a staging environment first.' },
  { pattern: /\b(password|secret|token|credential|api.?key)\b/i, hint: 'Involves credentials — avoid hard-coding; use env vars or secrets manager.' },
  { pattern: /\b(migrate|migration|schema change|alter table)\b/i, hint: 'Database migration — check for zero-downtime path and rollback script.' },
  { pattern: /\b(public|expose|open|unauthenticated)\b/i, hint: 'May expose data publicly — confirm auth requirements.' },
]

export function getRiskHints(text: string): string[] {
  return RISK_KEYWORDS.filter(r => r.pattern.test(text)).map(r => r.hint)
}

/** Board columns: statuses present in the data, in STATUS_ORDER, unknowns appended alphabetically. */
export function boardColumns(tasks: Task[]): string[] {
  const present = new Set(tasks.map(t => t.status))
  // Always show core workflow columns even when empty
  STATUS_ORDER.slice(0, 4).forEach(s => present.add(s))
  const ordered = STATUS_ORDER.filter(s => present.has(s))
  const extras = [...present].filter(s => !STATUS_ORDER.includes(s)).sort()
  return [...ordered, ...extras]
}

// Shared form field look used across the tasks screens.
export const taskFieldClass = 'px-2.5 py-1.5 border-border-visible placeholder-text-muted'
export const modalFieldClass = 'border-border-visible placeholder-text-muted'
export const fieldLabelClass = 'text-[10px] text-text-muted uppercase tracking-wide mb-1 block'

export type RightPanel =
  | null
  | { kind: 'task';    task: Task }
  | { kind: 'epic';    epic: Epic }
  | { kind: 'feature'; feature: Feature; epic: Epic }

export interface SimpleUser { id: string; name: string | null; username: string; email: string; role: string }
