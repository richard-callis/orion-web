'use client'

import { useSession, signOut } from 'next-auth/react'
import { useState, useRef, useEffect } from 'react'
import { LogOut } from 'lucide-react'

export function Header() {
  const { data: session } = useSession()
  const [open, setOpen] = useState(false)
  const [appName, setAppName] = useState('ORION')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/api/admin/settings')
      .then(r => r.json())
      .then(d => { if (d['app.name']) setAppName(d['app.name'] as string) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const initials = session?.user?.name
    ? session.user.name.slice(0, 2).toUpperCase()
    : session?.user?.email?.slice(0, 2).toUpperCase() ?? '?'

  return (
    <header className="flex items-center px-4 py-3 border-b border-border-subtle bg-bg-sidebar flex-shrink-0">
      <div className="w-7 h-7 rounded bg-accent flex items-center justify-center flex-shrink-0 mr-3">
        <span className="text-white font-bold text-xs">{appName.slice(0, 1).toUpperCase()}</span>
      </div>
      <span className="font-semibold text-text-primary">{appName}</span>

      {session && (
        <div className="ml-auto relative" ref={ref}>
          <button
            onClick={() => setOpen(o => !o)}
            className="w-8 h-8 rounded-full bg-accent/20 border border-accent/30 flex items-center justify-center text-xs font-semibold text-accent hover:bg-accent/30 transition-colors"
            title={session.user?.name ?? session.user?.email ?? ''}
          >
            {initials}
          </button>

          {open && (
            <div className="absolute right-0 top-10 w-48 bg-bg-sidebar border border-border-subtle rounded-lg shadow-lg py-1 z-50">
              <div className="px-3 py-2 border-b border-border-subtle">
                <div className="text-xs font-medium text-text-primary truncate">
                  {session.user?.name ?? session.user?.email}
                </div>
                <div className="text-[10px] text-text-muted truncate">
                  {session.user?.email}
                </div>
              </div>
              <button
                onClick={() => signOut({ callbackUrl: '/login' })}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-text-secondary hover:bg-bg-raised hover:text-status-error transition-colors"
              >
                <LogOut size={12} />
                Sign out
              </button>
            </div>
          )}
        </div>
      )}
    </header>
  )
}
