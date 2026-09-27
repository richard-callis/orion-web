import { timingSafeEqual } from 'crypto'
import { prisma } from './db'

/**
 * Find the environment whose federation token matches a presented bearer.
 *
 * Tokens are stored encrypted (non-deterministic), so they can't be matched
 * with a WHERE clause; the encryption middleware decrypts them on read and we
 * compare in constant time.
 */
export async function findEnvironmentByFederationToken(token: string): Promise<{ id: string } | null> {
  if (!token) return null
  const candidates = await prisma.environment.findMany({
    where: { federationToken: { not: null } },
    select: { id: true, federationToken: true },
  })
  const presented = Buffer.from(token)
  for (const env of candidates) {
    if (!env.federationToken) continue
    const stored = Buffer.from(env.federationToken)
    if (stored.length === presented.length && timingSafeEqual(stored, presented)) return { id: env.id }
  }
  return null
}
