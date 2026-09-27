import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { updateVaultSecret } from '@/lib/vault'

type Params = { params: Promise<{ id: string; secretId: string }> }

/**
 * PATCH /api/environments/:id/secrets/:secretId
 * Update a managed secret. If secretValues are provided, writes them to Vault
 * and marks the secret as applied.
 *
 * Body (all optional):
 *   description, namespace, secretStore, secretStoreKind, remoteRef,
 *   targetSecretName, refreshInterval, dataKeys, tags, status, statusMessage
 *   secretValues: Array<{ vaultKey: string; value: string; k8sKey: string }>
 *     — written directly to Vault, NEVER stored in the database
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id: environmentId, secretId } = await params
  const body = await req.json().catch(() => ({})) as Record<string, unknown>

  // Scope to the environment in the URL — a secret id from another env is a 404.
  const existing = await prisma.managedSecret.findFirst({
    where: { id: secretId, environmentId },
    select: { remoteRef: true, dataKeys: true },
  })
  if (!existing) return NextResponse.json({ error: 'Secret not found' }, { status: 404 })

  // secretValues carries actual secret data — ephemeral, never persisted.
  // A row with an EMPTY value means "keep the current value" (the edit form
  // can't show existing values); it may still change the k8s key mapping.
  // Keys are only ever deleted when listed explicitly in removeKeys.
  type SecretValueRow = { vaultKey: string; value?: string; k8sKey?: string }
  const rows: SecretValueRow[] = Array.isArray(body.secretValues)
    ? (body.secretValues as SecretValueRow[]).filter(r => typeof r?.vaultKey === 'string' && r.vaultKey.trim())
    : []
  const removeKeys: string[] = Array.isArray(body.removeKeys)
    ? (body.removeKeys as unknown[]).filter((k): k is string => typeof k === 'string' && !!k.trim()).map(k => k.trim())
    : []

  const toSet: Record<string, string> = {}
  for (const r of rows) {
    if (typeof r.value === 'string' && r.value !== '') toSet[r.vaultKey.trim()] = r.value
  }
  const writesVault = Object.keys(toSet).length > 0 || removeKeys.length > 0

  const vaultPath = body.remoteRef ? String(body.remoteRef) : existing.remoteRef

  try {
    if (writesVault) {
      try {
        await updateVaultSecret(vaultPath, toSet, removeKeys)
      } catch (e) {
        return NextResponse.json(
          { error: `Failed to write to Vault: ${e instanceof Error ? e.message : String(e)}` },
          { status: 502 },
        )
      }
    }

    // Merge key mappings: keep existing, update/add submitted rows, drop removed.
    let dataKeys: Array<{ remoteKey: string; secretKey: string }> | undefined
    if (rows.length > 0 || removeKeys.length > 0) {
      const map = new Map<string, string>()
      for (const k of (Array.isArray(existing.dataKeys) ? existing.dataKeys : []) as Array<{ remoteKey?: string; secretKey?: string }>) {
        if (k?.remoteKey) map.set(k.remoteKey, k.secretKey || k.remoteKey)
      }
      for (const r of rows) {
        const key = r.vaultKey.trim()
        map.set(key, r.k8sKey?.trim() || map.get(key) || key)
      }
      for (const k of removeKeys) map.delete(k)
      dataKeys = [...map].map(([remoteKey, secretKey]) => ({ remoteKey, secretKey }))
    } else if (body.dataKeys !== undefined) {
      dataKeys = (body.dataKeys ?? []) as Array<{ remoteKey: string; secretKey: string }>
    }

    const secret = await prisma.managedSecret.update({
      where: { id: secretId },
      data: {
        ...(body.description      !== undefined && { description:      body.description ? String(body.description) : null }),
        ...(body.namespace        !== undefined && { namespace:        String(body.namespace) }),
        ...(body.secretStore      !== undefined && { secretStore:      String(body.secretStore) }),
        ...(body.secretStoreKind  !== undefined && { secretStoreKind:  String(body.secretStoreKind) }),
        ...(body.remoteRef        !== undefined && { remoteRef:        String(body.remoteRef) }),
        ...(body.targetSecretName !== undefined && { targetSecretName: body.targetSecretName ? String(body.targetSecretName) : null }),
        ...(body.refreshInterval  !== undefined && { refreshInterval:  String(body.refreshInterval) }),
        ...(body.tags             !== undefined && { tags:             (body.tags ?? []) as object }),
        ...(dataKeys              !== undefined && { dataKeys }),
        ...(writesVault
          ? { status: 'applied', appliedAt: new Date(), statusMessage: null }
          : {
              ...(body.status        !== undefined && { status:        String(body.status) }),
              ...(body.statusMessage !== undefined && { statusMessage: body.statusMessage ? String(body.statusMessage) : null }),
            }),
      },
      include: { creator: { select: { id: true, username: true, name: true } } },
    })
    return NextResponse.json(secret)
  } catch {
    return NextResponse.json({ error: 'Failed to update secret' }, { status: 500 })
  }
}

/**
 * DELETE /api/environments/:id/secrets/:secretId
 * Delete a managed secret record.
 */
export async function DELETE(_: NextRequest, { params }: Params) {
  let user: Awaited<ReturnType<typeof requireAdmin>>
  try { user = await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id: environmentId, secretId } = await params

  try {
    const { count } = await prisma.managedSecret.deleteMany({ where: { id: secretId, environmentId } })
    if (count === 0) return NextResponse.json({ error: 'Secret not found' }, { status: 404 })
    return new NextResponse(null, { status: 204 })
  } catch {
    return NextResponse.json({ error: 'Failed to delete secret' }, { status: 500 })
  }
}
