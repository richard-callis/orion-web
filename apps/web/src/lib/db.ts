import { PrismaClient } from '@prisma/client'
import { registerEncryptionMiddleware } from './encryption-middleware'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ log: process.env.NODE_ENV === 'development' ? ['error'] : [] })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

// Register encryption middleware — transparent decrypt on all Environment/ExternalModel reads.
// Only active when ORION_ENCRYPTION_KEY is set. Without it, plaintext values pass through.
if (process.env.ORION_ENCRYPTION_KEY) {
  registerEncryptionMiddleware(prisma)
}
