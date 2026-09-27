export const dynamic = 'force-dynamic'

import { prisma } from '@/lib/db'
import { UsersClient } from './UsersClient'

export default async function UsersPage() {
  // Explicit select: never serialize password hashes, TOTP secrets or tokens.
  const rawUsers = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, username: true, name: true, email: true, role: true,
      provider: true, lastSeen: true, active: true, createdAt: true,
    },
  })

  // Serialize dates for client component
  const users = rawUsers.map(u => ({
    ...u,
    lastSeen: u.lastSeen?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
  }))

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div>
        <h1 className="text-lg font-semibold text-text-primary">User Management</h1>
        <p className="text-sm text-text-muted mt-0.5">
          Add local users here. SSO users are provisioned automatically on their first login.
        </p>
      </div>
      <UsersClient initialUsers={users} />
    </div>
  )
}
