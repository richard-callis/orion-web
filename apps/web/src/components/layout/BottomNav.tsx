'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Server, MessageSquare, ClipboardList, Bot, NotebookPen } from 'lucide-react'

const tabs = [
  { href: '/infrastructure', icon: Server, label: 'Infra' },
  { href: '/messages', icon: MessageSquare, label: 'Chat' },
  { href: '/tasks', icon: ClipboardList, label: 'Tasks' },
  { href: '/agents', icon: Bot, label: 'Agents' },
  { href: '/notes', icon: NotebookPen, label: 'Notes' },
]

export function BottomNav() {
  const pathname = usePathname()
  return (
    <nav className="flex md:hidden flex-shrink-0 border-t border-border-subtle bg-bg-sidebar" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      {tabs.map(({ href, icon: Icon, label }) => {
        const active = href === '/' ? pathname === '/' : pathname.startsWith(href)
        return (
          <Link key={href} href={href} className={`flex-1 flex flex-col items-center justify-center py-2.5 gap-1 text-[10px] font-medium transition-colors ${active ? 'text-accent' : 'text-text-muted'}`}>
            <Icon size={22} strokeWidth={active ? 2 : 1.5} />
            <span>{label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
