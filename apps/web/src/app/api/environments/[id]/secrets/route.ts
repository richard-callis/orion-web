import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { writeVaultSecret } from '@/lib/vault'

type Params = { params: Promise<{ id: string }> }

// ── Route handlers ────────────────────────────────────────────────────────────

/**
 * GET /api/environments/:id/secrets
 * Returns all managed secrets for this environment (metadata only — no values).
 */
export async function GET(_: NextRequest, { params }: Params) {
  let user: Awaited<ReturnType<typeof requireAdmin>>
  try { user = await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id: environmentId } = await params

  try {
    const secrets = await prisma.managedSecret.findMany({
      where: { environmentId },
      orderBy: { createdAt: 'desc' },
      include: { creator: { select: { id: true, username: true, name: true } } },
    })
    return NextResponse.json({ secrets })
  } catch {
    return NextResponse.json({ error: 'Failed to fetch secrets' }, { status: 500 })
  }
}

/**
 * POST /api/environments/:id/secrets
 *
 * Body:
 *   name, namespace, description, secretStore, secretStoreKind,
 *   remoteRef, targetSecretName, refreshInterval, tags
 *   secretValues: Array<{ vaultKey: string; value: string; k8sKey: string }>
 *     — written directly to Vault, NEVER stored in the database
 *
 * Flow:
 *   1. Validate required fields
 *   2. Write secretValues to Vault KV v2 at remoteRef path
 *   3. Store metadata-only ManagedSecret record (dataKeys = key names, no values)
 */
export async function POST(req: NextRequest, { params }: Params) {
  let user: Awaited<ReturnType<typeof requireAdmin>>
  try { user = await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id: environmentId } = await params
  const body = await req.json().catch(() => ({})) as Record<string, unknown>

  const name      = String(body.name      ?? '').trim()
  const remoteRef = String(body.remoteRef ?? '').trim()

  if (!name)      return NextResponse.json({ error: 'name is required' }, { status: 400 })
  if (!remoteRef) return NextResponse.json({ error: 'remoteRef (Vault path) is required' }, { status: 400 })

  // secretValues carries the actual secret data — ephemeral, never persisted
  type SecretValueRow = { vaultKey: string; value: string; k8sKey: string }
  const secretValues: SecretValueRow[] = Array.isArray(body.secretValues)
    ? (body.secretValues as SecretValueRow[]).filter(r => r.vaultKey?.trim() && r.value !== undefined)
    : []

  if (secretValues.length === 0) {
    return NextResponse.json({ error: 'At least one secret value is required' }, { status: 400 })
  }

  // Step 1 — write values directly to Vault
  try {
    const vaultData: Record<string, string> = {}
    for (const row of secretValues) {
      vaultData[row.vaultKey.trim()] = String(row.value)
    }
    await writeVaultSecret(remoteRef, vaultData)
  } catch (e) {
    return NextResponse.json(
      { error: `Failed to write to Vault: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    )
  }

  // Step 2 — derive key mappings (names only, no values) for ESO
  const dataKeys = secretValues.map(r => ({
    remoteKey: r.vaultKey.trim(),
    secretKey: (r.k8sKey?.trim() || r.vaultKey.trim()),
  }))

  // Step 3 — persist metadata only
  try {
    const secret = await prisma.managedSecret.create({
      data: {
        environmentId,
        createdBy:        user.id,
        name,
        namespace:        String(body.namespace       ?? 'default').trim() || 'default',
        description:      body.description ? String(body.description).trim() : null,
        secretStore:      String(body.secretStore     ?? 'vault-backend').trim() || 'vault-backend',
        secretStoreKind:  String(body.secretStoreKind ?? 'ClusterSecretStore').trim() || 'ClusterSecretStore',
        remoteRef,
        targetSecretName: body.targetSecretName ? String(body.targetSecretName).trim() || null : null,
        refreshInterval:  String(body.refreshInterval ?? '1h').trim() || '1h',
        dataKeys,               // key names only — values live in Vault
        tags: Array.isArray(body.tags) ? body.tags : [],
        status: 'applied',      // values are already in Vault
        appliedAt: new Date(),
      },
      include: { creator: { select: { id: true, username: true, name: true } } },
    })
    return NextResponse.json(secret, { status: 201 })
  } catch {
    // Vault write succeeded but DB write failed — record the issue clearly
    return NextResponse.json(
      { error: 'Secret was written to Vault but the metadata record could not be saved. Check the database.' },
      { status: 500 },
    )
  }
}
