export const dynamic = 'force-dynamic'

import { prisma } from '@/lib/db'
import { UsersClient } from './UsersClient'

export default async function UsersPage() {
  const rawUsers = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
  })

  // Serialize dates for client component
  const users = rawUsers.map(u => ({
    ...u,
    lastSeen: u.lastSeen?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  }))

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div>
        <h1 className="text-lg font-semibold text-text-primary">User Management</h1>
        <p className="text-sm text-text-muted mt-0.5">
          Users are automatically provisioned when they first authenticate via Authentik.
        </p>
      </div>
      <UsersClient initialUsers={users} />
    </div>
  )
}
