import Link from 'next/link'
import { SearchX } from 'lucide-react'

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-4 text-center p-8">
      <SearchX size={48} className="text-text-muted/40" />
      <h1 className="text-2xl font-bold text-text-primary">404 — Page not found</h1>
      <p className="text-sm text-text-muted max-w-sm">
        The page you&apos;re looking for doesn&apos;t exist or has been moved.
      </p>
      <Link
        href="/"
        className="px-4 py-2 text-sm rounded border border-border-visible bg-bg-raised text-text-primary hover:border-accent hover:text-accent transition-colors"
      >
        Go home
      </Link>
    </div>
  )
}
