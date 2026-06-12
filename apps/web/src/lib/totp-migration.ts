/**
 * SOC2 [M-002]: TOTP secret encryption migration utility.
 *
 * Backfills totpSecretEncrypted / totpRecoveryCodesEncrypted for users who
 * have plaintext values in the legacy columns. Safe to run multiple times —
 * users that already have an encrypted value are skipped.
 *
 * Called at startup from instrumentation.ts (nodejs runtime only) when
 * ORION_ENCRYPTION_KEY is present.
 */

import { prisma } from './db'
import { encrypt } from './encryption'

export async function migrateTotpToEncrypted(): Promise<{ migrated: number; skipped: number }> {
  if (!process.env.ORION_ENCRYPTION_KEY) return { migrated: 0, skipped: 0 }

  const users = await prisma.user.findMany({
    where: { totpEnabled: true },
    select: {
      id: true,
      totpSecret: true,
      totpRecoveryCodes: true,
      totpSecretEncrypted: true,
    },
  })

  let migrated = 0, skipped = 0
  for (const user of users) {
    if (user.totpSecretEncrypted) { skipped++; continue }
    const updates: Record<string, string> = {}
    if (user.totpSecret) updates.totpSecretEncrypted = encrypt(user.totpSecret)
    if (user.totpRecoveryCodes) updates.totpRecoveryCodesEncrypted = encrypt(user.totpRecoveryCodes)
    if (Object.keys(updates).length > 0) {
      await prisma.user.update({ where: { id: user.id }, data: updates })
      migrated++
    }
  }
  return { migrated, skipped }
}
