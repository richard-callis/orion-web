/**
 * POST /api/setup/vault
 *
 * Initialises HashiCorp Vault during the ORION setup wizard:
 *   1. Initialises Vault (Shamir 5-of-3)
 *   2. Unseals with the threshold keys
 *   3. Creates a scoped orion-admin policy (root is never persisted)
 *   4. Mints a 1-year renewable admin token, revokes root
 *   5. Stores unseal keys + admin token encrypted in DB (no files written to disk)
 *   6. Generates vault-proxy TLS certs
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireWizardSession } from '@/lib/setup-guard'
import { generateVaultProxyCerts } from '@/lib/vault-proxy'
import { encrypt, encryptJson } from '@/lib/encryption'

const VAULT_ADDR       = process.env.VAULT_ADDR ?? 'http://vault:8200'
const UNSEAL_SHARES    = 5
const UNSEAL_THRESHOLD = 3

// Minimum policy ORION needs: manage AppRole auth, policies, KV mount, and secrets.
// Deliberately excludes sys/seal, sys/rekey, sys/generate-root, and all other core ops.
const ORION_ADMIN_POLICY = `
path "sys/auth/approle"    { capabilities = ["sudo", "create", "update", "read"] }
path "sys/auth/approle/*"  { capabilities = ["create", "update", "read", "delete", "list"] }
path "auth/approle/*"      { capabilities = ["create", "update", "read", "delete", "list"] }
path "sys/policies/acl/*"  { capabilities = ["create", "update", "read", "delete", "list"] }
path "sys/mounts/secret"   { capabilities = ["create", "update", "sudo"] }
path "sys/mounts/secret/*" { capabilities = ["create", "update", "read"] }
path "secret/*"            { capabilities = ["create", "update", "read", "delete", "list"] }
`.trim()

export async function POST(req: NextRequest) {
  if (!await requireWizardSession(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))

  if (body.skip) {
    return NextResponse.json({ ok: true, skipped: true })
  }

  try {
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
    const thresholdKeys: string[] = keys.slice(0, UNSEAL_THRESHOLD)

    // Unseal with threshold keys
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

    // Create scoped admin policy
    await fetch(`${VAULT_ADDR}/v1/sys/policies/acl/orion-admin`, {
      method: 'PUT',
      headers: { 'X-Vault-Token': root_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ policy: ORION_ADMIN_POLICY }),
      signal: AbortSignal.timeout(5000),
    })

    // Mint a 1-year renewable admin token bound to that policy
    const adminTokenRes = await fetch(`${VAULT_ADDR}/v1/auth/token/create`, {
      method: 'POST',
      headers: { 'X-Vault-Token': root_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        display_name: 'orion-admin',
        policies: ['orion-admin'],
        ttl: '8760h',
        renewable: true,
      }),
      signal: AbortSignal.timeout(5000),
    })
    if (!adminTokenRes.ok) {
      const errText = await adminTokenRes.text()
      return NextResponse.json(
        { error: 'vault_admin_token_failed', message: errText },
        { status: 502 }
      )
    }
    const { auth: { client_token: adminToken } } = await adminTokenRes.json()

    // Revoke root token — never persisted
    await fetch(`${VAULT_ADDR}/v1/auth/token/revoke-self`, {
      method: 'POST',
      headers: { 'X-Vault-Token': root_token },
      signal: AbortSignal.timeout(5000),
    })

    // Store unseal keys + admin token encrypted in DB — no files written to disk
    await prisma.$transaction([
      prisma.systemSetting.upsert({
        where:  { key: 'vault.unsealKeys' },
        update: { value: encryptJson(thresholdKeys) },
        create: { key: 'vault.unsealKeys', value: encryptJson(thresholdKeys) },
      }),
      prisma.systemSetting.upsert({
        where:  { key: 'vault.adminToken' },
        update: { value: encrypt(adminToken) },
        create: { key: 'vault.adminToken', value: encrypt(adminToken) },
      }),
      prisma.systemSetting.upsert({
        where:  { key: 'vault.initialized' },
        update: { value: true },
        create: { key: 'vault.initialized', value: true },
      }),
    ])

    // Generate vault-proxy TLS certs so the Envoy sidecar can start
    await generateVaultProxyCerts()

    // Root token returned once for break-glass storage — not persisted in ORION
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
