import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireWizardSession } from '@/lib/setup-guard'

const VAULT_ADDR = process.env.VAULT_ADDR ?? 'http://vault:8200'

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
      body: JSON.stringify({ secret_shares: 5, secret_threshold: 3 }),
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

    // Unseal with first 3 of the 5 keys
    for (let i = 0; i < 3; i++) {
      await fetch(`${VAULT_ADDR}/v1/sys/unseal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: keys[i] }),
        signal: AbortSignal.timeout(5000),
      })
    }

    // Persist root token and initialized state
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
