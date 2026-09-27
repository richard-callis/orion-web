import { AlertCircle, X } from 'lucide-react'
import { cn } from './cn'

export function ErrorBanner({
  message,
  onDismiss,
  onRetry,
  className,
}: {
  message: React.ReactNode
  onDismiss?: () => void
  onRetry?: () => void
  className?: string
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-xs text-red-300',
        className,
      )}
    >
      <AlertCircle size={14} className="shrink-0 mt-px text-red-400" aria-hidden="true" />
      <div className="flex-1 break-words">{message}</div>
      {onRetry && (
        <button type="button" onClick={onRetry} className="text-red-300 underline hover:text-red-200 shrink-0">
          Retry
        </button>
      )}
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss error" className="text-red-300 hover:text-red-200 shrink-0">
          <X size={12} />
        </button>
      )}
    </div>
  )
}
