import { cn } from './cn'

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center py-12 px-4 gap-2', className)}>
      {icon && <div className="text-text-muted mb-1" aria-hidden="true">{icon}</div>}
      <p className="text-sm text-text-secondary">{title}</p>
      {description && <p className="text-xs text-text-muted max-w-md">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
