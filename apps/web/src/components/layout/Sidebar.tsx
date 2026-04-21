'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import {
  LayoutDashboard, Server, Database, MessageSquare, Bot,
  Bell, KeyRound, Archive, FileText, ClipboardList,
  ChevronLeft, ChevronRight, BookOpen, Settings2, GitBranch, Network, Sparkles, MessageCircle,
} from 'lucide-react'
import { usePendingTools } from '@/hooks/usePendingTools'

const nav = [
  { href: '/',               icon: LayoutDashboard, label: 'Dashboard' },
  { href: '/infrastructure', icon: Server,           label: 'Infrastructure' },
  { href: '/gitops',         icon: GitBranch,        label: 'GitOps' },
  { href: '/storage',        icon: Database,         label: 'Storage' },
  { href: '/chat',           icon: MessageSquare,    label: 'Claude Chat' },
  { href: '/tasks',          icon: ClipboardList,    label: 'Tasks' },
  { href: '/agents',         icon: Bot,              label: 'Agents' },
  { href: '/ingress',        icon: Network,          label: 'Ingress' },
  { href: '/alerts',         icon: Bell,             label: 'Alerts' },
  { href: '/secrets',        icon: KeyRound,         label: 'Secrets' },
  { href: '/backups',        icon: Archive,          label: 'Backups' },
  { href: '/logs',           icon: FileText,         label: 'Logs' },
  { href: '/notes',          icon: BookOpen,         label: 'Wiki' },
  { href: '/nova',            icon: Sparkles,        label: 'Nova' },
  { href: '/chatrooms',       icon: MessageSquare,   label: 'Chat Rooms' },
]

export function Sidebar() {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState(false)
  const { count: pendingCount } = usePendingTools()

  const NavLink = ({ href, icon: Icon, label, badge }: { href: string; icon: React.ElementType; label: string; badge?: number }) => {
    const active = href === '/' ? pathname === '/' : pathname.startsWith(href)
    return (
      <Link
        href={href}
        title={collapsed ? label : undefined}
        className={`flex items-center py-2.5 text-sm transition-colors ${
          collapsed ? 'justify-center px-0' : 'gap-3 px-4'
        } ${
          active
            ? 'bg-accent/15 text-accent border-r-2 border-accent'
            : 'text-text-secondary hover:bg-bg-raised hover:text-text-primary'
        }`}
      >
        <Icon size={18} className="flex-shrink-0" />
        {!collapsed && <span className="truncate flex-1">{label}</span>}
        {badge ? (
          <span className={`flex-shrink-0 min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold flex items-center justify-center bg-orange-500 text-white ${collapsed ? 'absolute ml-3 -mt-3' : ''}`}>
            {badge}
          </span>
        ) : null}
      </Link>
    )
  }

  return (
    <aside className={`hidden md:flex flex-col bg-bg-sidebar border-r border-border-subtle transition-all duration-200 flex-shrink-0 ${collapsed ? 'w-16' : 'w-56'}`}>
      {/* Nav */}
      <nav className="flex-1 py-2 overflow-y-auto">
        {nav.map(item => <NavLink key={item.href} {...item} />)}
      </nav>

      {/* Divider + Admin link */}
      <div className="border-t border-border-subtle">
        <NavLink href="/admin" icon={Settings2} label="Administration" badge={pendingCount || undefined} />
      </div>

      {/* Collapse toggle at bottom */}
      <button
        onClick={() => setCollapsed(c => !c)}
        className={`flex items-center py-2.5 text-xs text-text-muted hover:text-text-secondary hover:bg-bg-raised transition-colors flex-shrink-0 border-t border-border-subtle ${
          collapsed ? 'justify-center px-0' : 'gap-2 px-4'
        }`}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed ? <ChevronRight size={15} /> : (
          <>
            <ChevronLeft size={15} />
            <span className="text-xs">Collapse</span>
          </>
        )}
      </button>
    </aside>
  )
}
