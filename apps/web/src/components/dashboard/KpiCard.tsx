type Color = 'healthy' | 'warning' | 'error' | 'info'

const colorMap: Record<Color, string> = {
  healthy: 'text-status-healthy border-status-healthy/30',
  warning: 'text-status-warning border-status-warning/30',
  error:   'text-status-error   border-status-error/30',
  info:    'text-status-info    border-status-info/30',
}

export function KpiCard({
  label, value, total, color = 'info',
}: {
  label: string
  value: number | string
  total?: number
  color?: Color
}) {
  return (
    <div className={`rounded-lg border bg-bg-card p-4 ${colorMap[color]}`}>
      <p className="text-xs text-text-muted mb-1">{label}</p>
      <p className="text-2xl font-mono font-bold">
        {value}
        {total != null && <span className="text-sm text-text-muted font-normal"> / {total}</span>}
      </p>
    </div>
  )
}
