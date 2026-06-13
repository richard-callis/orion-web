/**
 * Internal unsealer API — used by the vault-unsealer sidecar only.
 * Not exposed outside the Docker internal network.
 *
 * GET  — returns the decrypted threshold unseal keys
 * POST — migrates existing installs: accepts plaintext keys, stores encrypted
 *
 * Both methods require: Authorization: Bearer <ORION_UNSEALER_TOKEN>
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/db'
import { encrypt, encryptJson, decryptJsonStrict } from '@/lib/encryption'
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'

const UNSEALER_TOKEN = process.env.ORION_UNSEALER_TOKEN

function authorized(req: NextRequest): boolean {
  if (!UNSEALER_TOKEN) return false
  const provided = req.headers.get('authorization') ?? ''
  const expected = `Bearer ${UNSEALER_TOKEN}`
  // Constant-time comparison — this guards Vault unseal keys, the most
  // sensitive secret in the system. Plain === leaks token length as a timing oracle.
  if (provided.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const setting = await prisma.systemSetting.findUnique({
    where: { key: 'vault.unsealKeys' },
  })

  if (!setting?.value) {
    return NextResponse.json(
      { error: 'vault_not_initialized', message: 'Unseal keys not found — run the Vault setup wizard or POST keys to migrate.' },
      { status: 404 }
    )
  }

  const keys = decryptJsonStrict<string[]>(setting.value, "vault.unsealKeys")

  // SOC2: audit vault unseal key retrieval
  logAudit({
    userId: 'system:unsealer',
    action: 'vault_unseal',
    target: 'vault:unsealKeys',
    detail: { keyCount: keys.length },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req.headers),
  }).catch(() => {})

  return NextResponse.json({ keys })
}

/**
 * Migration endpoint: accepts plaintext unseal keys from an existing install
 * (e.g. previously stored in files) and persists them encrypted in the DB.
 * Safe to call multiple times — idempotent.
 */
export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const { keys, adminToken } = body as { keys?: unknown; adminToken?: string }

  if (!Array.isArray(keys) || keys.length === 0) {
    return NextResponse.json({ error: 'keys array is required' }, { status: 400 })
  }

  const ops = [
    prisma.systemSetting.upsert({
      where:  { key: 'vault.unsealKeys' },
      update: { value: encryptJson(keys) },
      create: { key: 'vault.unsealKeys', value: encryptJson(keys) },
    }),
  ]

  if (adminToken) {
    ops.push(
      prisma.systemSetting.upsert({
        where:  { key: 'vault.adminToken' },
        update: { value: encrypt(adminToken) },
        create: { key: 'vault.adminToken', value: encrypt(adminToken) },
      })
    )
  }

  await prisma.$transaction(ops)

  // SOC2: audit vault unseal key migration/overwrite
  logAudit({
    userId: 'system:unsealer',
    action: 'vault_reseal',
    target: 'vault:unsealKeys',
    detail: { keyCount: keys.length, adminTokenUpdated: !!adminToken },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req.headers),
  }).catch(() => {})

  return NextResponse.json({ ok: true, migrated: keys.length })
}
