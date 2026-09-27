import { Loader2 } from 'lucide-react'

/** Route-level loading fallback (used by loading.tsx files). */
export function PageLoading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-sm text-text-muted">
        <Loader2 size={16} className="animate-spin" aria-hidden="true" />
        {label}
      </div>
    </div>
  )
}
