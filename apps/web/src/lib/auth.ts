import { headers } from 'next/headers'
import { prisma } from './db'

export interface AppUser {
  id: string
  username: string
  email: string
  name: string | null
  role: string
  active: boolean
}

export async function getCurrentUser(): Promise<AppUser | null> {
  const h = headers()
  const username = h.get('x-authentik-username') ?? h.get('x-forwarded-user')
  const email = h.get('x-authentik-email') ?? ''
  const name = h.get('x-authentik-name')
  const externalId = h.get('x-authentik-uid')

  if (!username) return null

  // Upsert user record
  const user = await prisma.user.upsert({
    where: { username },
    update: {
      email: email || undefined,
      name: name || undefined,
      externalId: externalId || undefined,
      lastSeen: new Date(),
    },
    create: { username, email, name, externalId, role: 'user', provider: 'authentik' },
  })

  if (!user.active) return null
  return user
}

export async function requireAdmin(): Promise<AppUser> {
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') {
    throw new Error('Unauthorized')
  }
  return user
}
