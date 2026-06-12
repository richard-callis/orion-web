/**
 * POST /api/internal/encryption/rotate — Re-encrypt all secrets with a new key.
 *
 * Internal-only endpoint (Docker network). Requires Authorization: Bearer <key>.
 * Safe to retry — each record is independent. Encrypted values auto-pass through.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/db'
import { encrypt, decrypt, encryptWithKey } from '@/lib/encryption'

export async function POST(req: NextRequest) {
  // MAJOR fix: previously authenticated with ORION_ENCRYPTION_KEY itself.
  // Any caller who knew the encryption key could supply a body.key to re-encrypt
  // all secrets under an attacker-controlled key — a credential ransom/takeover.
  // Now uses a separate ORION_ROTATION_TOKEN. The encryption key is a data secret
  // and must not double as an API credential.
  const rotationToken = process.env.ORION_ROTATION_TOKEN
  if (!rotationToken) {
    return NextResponse.json(
      { error: 'ORION_ROTATION_TOKEN not configured — key rotation is disabled' },
      { status: 503 }
    )
  }
  const auth = req.headers.get('authorization') ?? ''
  const expected = `Bearer ${rotationToken}`
  if (auth.length !== expected.length || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: unknown
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const newKeyBase64 = (body as any)?.key as string | undefined
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
        updates.gatewayToken = encryptWithKey(plaintext, newKeyBase64)
        migrated++
      } catch (e) {
        console.error('Key rotation error [Environment.gatewayToken]:', e)
        errors.push({ model: 'Environment', id: env.id, field: 'gatewayToken', error: 'Key rotation failed' })
      }
    }

    if (env.kubeconfig) {
      try {
        const plaintext = decrypt(env.kubeconfig)
        updates.kubeconfig = encryptWithKey(plaintext, newKeyBase64)
        migrated++
      } catch (e) {
        console.error('Key rotation error [Environment.kubeconfig]:', e)
        errors.push({ model: 'Environment', id: env.id, field: 'kubeconfig', error: 'Key rotation failed' })
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
        const encrypted = encryptWithKey(plaintext, newKeyBase64)
        await prisma.externalModel.update({ where: { id: ext.id }, data: { apiKey: encrypted } })
        migrated++
      } catch (e) {
        console.error('Key rotation error [ExternalModel.apiKey]:', e)
        errors.push({ model: 'ExternalModel', id: ext.id, field: 'apiKey', error: 'Key rotation failed' })
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
