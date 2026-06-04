#!/usr/bin/env node
/**
 * One-time migration: encrypt all plaintext Environment/ExternalModel secrets.
 *
 * Run: npx tsx apps/web/src/lib/encryption-migrate.ts
 *
 * Safe to run multiple times — encrypted values have the 'enc:v1:' prefix and
 * are skipped. Safe to abort and resume.
 *
 * Generate a new key: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */

import { PrismaClient } from '@prisma/client'
import { encrypt } from './encryption'

// MAJOR fix: the shared `prisma` client has the auto-encrypt middleware attached,
// which decrypts values on read. This means the migrate script sees plaintext
// from the middleware — the `plaintext === env.gatewayToken` detection always
// returned true, causing every row to be redundantly re-encrypted on every run.
// Using a raw client (no middleware) lets us see the actual on-disk value and
// correctly detect which rows are already encrypted via the 'enc:v1:' prefix.
const raw = new PrismaClient()

async function migrate() {
  const key = process.env.ORION_ENCRYPTION_KEY
  if (!key) {
    console.error('ERROR: ORION_ENCRYPTION_KEY environment variable is not set')
    process.exit(1)
  }

  console.log('Starting encryption migration...')
  console.log(`Key length: ${key.length} bytes (base64)`)

  // ── Migrate Environment fields ──────────────────────────────────────
  const environments = await raw.environment.findMany({
    select: { id: true, gatewayToken: true, kubeconfig: true, name: true },
  })

  console.log(`\nFound ${environments.length} environments`)

  let envMigrated = 0
  let envSkipped = 0

  for (const env of environments) {
    const updates: Record<string, string> = {}

    if (env.gatewayToken && !env.gatewayToken.startsWith('enc:v1:')) {
      updates.gatewayToken = encrypt(env.gatewayToken)
      envMigrated++
      console.log(`  encrypted gatewayToken for "${env.name}"`)
    } else if (env.gatewayToken) {
      envSkipped++
    }

    if (env.kubeconfig && !env.kubeconfig.startsWith('enc:v1:')) {
      updates.kubeconfig = encrypt(env.kubeconfig)
      envMigrated++
      console.log(`  encrypted kubeconfig for "${env.name}"`)
    } else if (env.kubeconfig) {
      envSkipped++
    }

    if (Object.keys(updates).length > 0) {
      await raw.environment.update({ where: { id: env.id }, data: updates })
    }
  }

  // ── Migrate ExternalModel.apiKey ────────────────────────────────────
  const extModels = await raw.externalModel.findMany({
    select: { id: true, apiKey: true, name: true },
  })

  console.log(`\nFound ${extModels.length} external models`)

  let extMigrated = 0
  let extSkipped = 0

  for (const ext of extModels) {
    if (ext.apiKey && !ext.apiKey.startsWith('enc:v1:')) {
      await raw.externalModel.update({
        where: { id: ext.id },
        data: { apiKey: encrypt(ext.apiKey) },
      })
      extMigrated++
      console.log(`  encrypted apiKey for "${ext.name}"`)
    } else if (ext.apiKey) {
      extSkipped++
    }
  }

  await raw.$disconnect()

  console.log(`\n--- Migration complete ---`)
  console.log(`Environment fields: ${envMigrated} migrated, ${envSkipped} skipped (already encrypted)`)
  console.log(`ExternalModel fields: ${extMigrated} migrated, ${extSkipped} skipped (already encrypted)`)
  console.log(`Total: ${envMigrated + extMigrated} fields encrypted`)
}

migrate().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
