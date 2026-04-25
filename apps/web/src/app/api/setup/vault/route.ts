import { NextRequest, NextResponse } from 'next/server'
import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { prisma } from '@/lib/db'
import { requireWizardSession } from '@/lib/setup-guard'

const VAULT_ADDR = process.env.VAULT_ADDR ?? 'http://vault:8200'
const UNSEAL_KEYS_DIR = process.env.VAULT_UNSEAL_KEYS_DIR ?? '/vault/unseal-keys'
const UNSEAL_SHARES = 5
const UNSEAL_THRESHOLD = 3

export async function POST(req: NextRequest) {
  if (!await requireWizardSession(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))

  if (body.skip) {
    return NextResponse.json({ ok: true, skipped: true })
  }

  try {
    // Check if Vault is reachable and its current state
    const healthRes = await fetch(`${VAULT_ADDR}/v1/sys/health`, {
      signal: AbortSignal.timeout(5000),
    })
    const health = await healthRes.json()

    if (health.initialized) {
      return NextResponse.json(
        { error: 'vault_already_initialized', message: 'Vault is already initialized' },
        { status: 409 }
      )
    }

    // Initialize Vault
    const initRes = await fetch(`${VAULT_ADDR}/v1/sys/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret_shares: UNSEAL_SHARES, secret_threshold: UNSEAL_THRESHOLD }),
      signal: AbortSignal.timeout(15000),
    })

    if (!initRes.ok) {
      const errText = await initRes.text()
      return NextResponse.json(
        { error: 'vault_init_failed', message: errText },
        { status: 502 }
      )
    }

    const { keys, root_token } = await initRes.json()

    const thresholdKeys = keys.slice(0, UNSEAL_THRESHOLD)

    await mkdir(UNSEAL_KEYS_DIR, { recursive: true })
    await Promise.all(
      thresholdKeys.map((key: string, i: number) =>
        writeFile(join(UNSEAL_KEYS_DIR, `unseal-key-${i + 1}`), key, { mode: 0o600 })
      )
    )

    await Promise.all(
      thresholdKeys.map((key: string) =>
        fetch(`${VAULT_ADDR}/v1/sys/unseal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key }),
          signal: AbortSignal.timeout(5000),
        })
      )
    )

    await prisma.$transaction([
      prisma.systemSetting.upsert({
        where: { key: 'vault.rootToken' },
        update: { value: root_token },
        create: { key: 'vault.rootToken', value: root_token },
      }),
      prisma.systemSetting.upsert({
        where: { key: 'vault.initialized' },
        update: { value: true },
        create: { key: 'vault.initialized', value: true },
      }),
    ])

    return NextResponse.json({ ok: true, keys, rootToken: root_token })

  } catch (err: unknown) {
    const isTimeout = (err as { name?: string })?.name === 'TimeoutError'
    if (isTimeout) {
      return NextResponse.json(
        { error: 'vault_unavailable', message: 'Vault did not respond. Ensure it is running.' },
        { status: 503 }
      )
    }
    return NextResponse.json(
      { error: 'vault_error', message: String(err) },
      { status: 500 }
    )
  }
}
