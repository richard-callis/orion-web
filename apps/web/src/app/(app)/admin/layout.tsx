'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, Settings, Cpu, Users, ShieldCheck, ScrollText, Layers } from 'lucide-react'

const adminNav = [
  { href: '/admin',               icon: LayoutDashboard, label: 'Overview'     },
  { href: '/admin/settings',      icon: Settings,        label: 'Settings'     },
  { href: '/admin/models',        icon: Cpu,             label: 'Models'       },
  { href: '/admin/users',         icon: Users,           label: 'Users'        },
  { href: '/admin/environments',  icon: Layers,          label: 'Environments' },
  { href: '/admin/sso',           icon: ShieldCheck,     label: 'SSO'          },
  { href: '/admin/audit',         icon: ScrollText,      label: 'Audit Log'    },
]

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  return (
    <div className="absolute inset-0 flex overflow-hidden">
      {/* Left sub-nav */}
      <aside className="w-48 flex-shrink-0 bg-bg-sidebar border-r border-border-subtle flex flex-col">
        <div className="px-4 py-3 border-b border-border-subtle flex items-center gap-2 flex-shrink-0">
          <Settings size={15} className="text-accent flex-shrink-0" />
          <span className="text-sm font-semibold text-text-primary">Administration</span>
        </div>
        <nav className="flex-1 py-2 overflow-y-auto">
          {adminNav.map(({ href, icon: Icon, label }) => {
            const active = href === '/admin' ? pathname === '/admin' : pathname.startsWith(href)
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-2.5 px-4 py-2 text-sm transition-colors ${
                  active
                    ? 'bg-accent/15 text-accent border-r-2 border-accent'
                    : 'text-text-secondary hover:bg-bg-raised hover:text-text-primary'
                }`}
              >
                <Icon size={15} className="flex-shrink-0" />
                <span className="truncate">{label}</span>
              </Link>
            )
          })}
        </nav>
      </aside>

      {/* Page content */}
      <div className="flex-1 overflow-auto">
        {children}
      </div>
    </div>
  )
}
