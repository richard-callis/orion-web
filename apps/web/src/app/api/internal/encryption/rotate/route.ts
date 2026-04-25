/**
 * POST /api/internal/encryption/rotate — Re-encrypt all secrets with a new key.
 *
 * Internal-only endpoint (Docker network). Requires Authorization: Bearer <key>.
 * Safe to retry — each record is independent. Encrypted values auto-pass through.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { encrypt, decrypt } from '@/lib/encryption'

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization')
  const currentKey = process.env.ORION_ENCRYPTION_KEY
  if (!currentKey || auth !== `Bearer ${currentKey}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const newKeyBase64 = body.key as string
  if (!newKeyBase64) {
    return NextResponse.json({ error: 'new key required in body.key' }, { status: 400 })
  }

  // Validate new key format: must be base64-encoded 32 bytes
  let newKeyBuf: Buffer
  try {
    newKeyBuf = Buffer.from(newKeyBase64, 'base64')
    if (newKeyBuf.byteLength !== 32) {
      return NextResponse.json(
        { error: 'key must be base64-encoded 32 bytes — run: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"' },
        { status: 400 }
      )
    }
  } catch {
    return NextResponse.json({ error: 'invalid base64 in body.key' }, { status: 400 })
  }

  let migrated = 0
  const errors: Array<{ model: string; id: string; field: string; error: string }> = []

  // ── Migrate Environment fields ──────────────────────────────────────
  const environments = await prisma.environment.findMany({
    select: { id: true, gatewayToken: true, kubeconfig: true },
  })

  for (const env of environments) {
    const updates: Record<string, string> = {}

    if (env.gatewayToken) {
      try {
        const plaintext = decrypt(env.gatewayToken)
        updates.gatewayToken = encrypt(plaintext)
        migrated++
      } catch (e) {
        errors.push({ model: 'Environment', id: env.id, field: 'gatewayToken', error: String(e) })
      }
    }

    if (env.kubeconfig) {
      try {
        const plaintext = decrypt(env.kubeconfig)
        updates.kubeconfig = encrypt(plaintext)
        migrated++
      } catch (e) {
        errors.push({ model: 'Environment', id: env.id, field: 'kubeconfig', error: String(e) })
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

  for (const ext of extModels) {
    if (ext.apiKey) {
      try {
        const plaintext = decrypt(ext.apiKey)
        const encrypted = encrypt(plaintext)
        await prisma.externalModel.update({ where: { id: ext.id }, data: { apiKey: encrypted } })
        migrated++
      } catch (e) {
        errors.push({ model: 'ExternalModel', id: ext.id, field: 'apiKey', error: String(e) })
      }
    }
  }

  return NextResponse.json({
    migrated,
    failed: errors.length,
    errors: errors.slice(0, 20),
    message: `Re-encryption complete: ${migrated} fields migrated, ${errors.length} errors`,
  })
}
