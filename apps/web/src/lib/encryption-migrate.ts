#!/usr/bin/env node
/**
 * One-time migration: encrypt all plaintext Environment/ExternalModel secrets.
 *
 * Run: npx tsx apps/web/src/lib/encryption-migrate.ts
 *
 * Safe to run multiple times — encrypted values pass through decrypt() unchanged.
 * Safe to abort and resume — decrypt() has plaintext passthrough.
 *
 * Generate a new key: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */

import { prisma } from './db'
import { encrypt, decrypt } from './encryption'

async function migrate() {
  const key = process.env.ORION_ENCRYPTION_KEY
  if (!key) {
    console.error('ERROR: ORION_ENCRYPTION_KEY environment variable is not set')
    process.exit(1)
  }

  console.log('Starting encryption migration...')
  console.log(`Key length: ${key.length} bytes (base64)`)

  // ── Migrate Environment fields ──────────────────────────────────────
  const environments = await prisma.environment.findMany({
    select: { id: true, gatewayToken: true, kubeconfig: true, name: true },
  })

  console.log(`\nFound ${environments.length} environments`)

  let envMigrated = 0
  let envSkipped = 0

  for (const env of environments) {
    const updates: Record<string, string> = {}

    if (env.gatewayToken) {
      const plaintext = decrypt(env.gatewayToken)
      if (plaintext !== env.gatewayToken) {
        updates.gatewayToken = encrypt(plaintext)
        envMigrated++
        console.log(`  encrypted gatewayToken for "${env.name}"`)
      } else {
        envSkipped++
      }
    }

    if (env.kubeconfig) {
      const plaintext = decrypt(env.kubeconfig)
      if (plaintext !== env.kubeconfig) {
        updates.kubeconfig = encrypt(plaintext)
        envMigrated++
        console.log(`  encrypted kubeconfig for "${env.name}"`)
      } else {
        envSkipped++
      }
    }

    if (Object.keys(updates).length > 0) {
      await prisma.environment.update({ where: { id: env.id }, data: updates })
    }
  }

  // ── Migrate ExternalModel.apiKey ────────────────────────────────────
  const extModels = await prisma.externalModel.findMany({
    select: { id: true, apiKey: true, name: true },
  })

  console.log(`\nFound ${extModels.length} external models`)

  let extMigrated = 0
  let extSkipped = 0

  for (const ext of extModels) {
    if (ext.apiKey) {
      const plaintext = decrypt(ext.apiKey)
      if (plaintext !== ext.apiKey) {
        const encrypted = encrypt(plaintext)
        await prisma.externalModel.update({
          where: { id: ext.id },
          data: { apiKey: encrypted },
        })
        extMigrated++
        console.log(`  encrypted apiKey for "${ext.name}"`)
      } else {
        extSkipped++
      }
    }
  }

  console.log(`\n--- Migration complete ---`)
  console.log(`Environment fields: ${envMigrated} migrated, ${envSkipped} skipped (already encrypted)`)
  console.log(`ExternalModel fields: ${extMigrated} migrated, ${extSkipped} skipped (already encrypted)`)
  console.log(`Total: ${envMigrated + extMigrated} fields encrypted`)
}

migrate().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
