'use client'
import { useEffect } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[app-error-boundary]', error)
  }, [error])

  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[300px] gap-4 p-8 text-center">
      <AlertTriangle size={36} className="text-status-warning" />
      <div>
        <h2 className="text-base font-semibold text-text-primary mb-1">Something went wrong</h2>
        <p className="text-sm text-text-muted max-w-md">
          {error.message ?? 'An unexpected error occurred. Try refreshing the page.'}
        </p>
        {error.digest && (
          <p className="text-[10px] text-text-muted/60 mt-2 font-mono">ref: {error.digest}</p>
        )}
      </div>
      <button
        onClick={reset}
        className="flex items-center gap-1.5 px-4 py-2 text-sm rounded border border-border-visible bg-bg-raised text-text-primary hover:border-accent hover:text-accent transition-colors"
      >
        <RefreshCw size={13} /> Try again
      </button>
    </div>
  )
}
