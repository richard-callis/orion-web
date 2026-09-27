import os from 'node:os'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { encryptionExtension } from './encryption-middleware'

/**
 * Prisma 7 has no bundled query engine: the client talks to Postgres through a
 * driver adapter (node-postgres). The pool is sized like Prisma 5's default
 * (num_cpus * 2 + 1) unless DATABASE_POOL_MAX is set.
 */
export function createPrismaClient(opts: { encryption?: boolean } = {}): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DATABASE_POOL_MAX) || os.availableParallelism() * 2 + 1,
  })
  const base = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['error'] : [],
  })
  // Encryption extension — transparent encrypt/decrypt of Environment/ExternalModel
  // secrets. Only active when ORION_ENCRYPTION_KEY is set; otherwise plaintext
  // values pass through. The extension only adds query hooks (no new model
  // methods), so the extended client is API-identical to PrismaClient.
  if (opts.encryption !== false && process.env.ORION_ENCRYPTION_KEY) {
    return base.$extends(encryptionExtension) as unknown as PrismaClient
  }
  return base
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

export const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
