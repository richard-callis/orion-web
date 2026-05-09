import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { writeVaultSecret } from '@/lib/vault'

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
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { secretId } = await params
  const body = await req.json().catch(() => ({})) as Record<string, unknown>

  // secretValues carries actual secret data — ephemeral, never persisted
  type SecretValueRow = { vaultKey: string; value: string; k8sKey: string }
  const secretValues: SecretValueRow[] = Array.isArray(body.secretValues)
    ? (body.secretValues as SecretValueRow[]).filter(r => r.vaultKey?.trim() && r.value !== undefined)
    : []

  try {
    // If secretValues are provided, write them to Vault first
    if (secretValues.length > 0) {
      // Resolve the Vault path: use updated remoteRef from body, or fall back to current record
      let vaultPath = body.remoteRef ? String(body.remoteRef) : null
      if (!vaultPath) {
        const existing = await prisma.managedSecret.findUnique({ where: { id: secretId }, select: { remoteRef: true } })
        if (!existing) return NextResponse.json({ error: 'Secret not found' }, { status: 404 })
        vaultPath = existing.remoteRef
      }

      try {
        const vaultData: Record<string, string> = {}
        for (const row of secretValues) {
          vaultData[row.vaultKey.trim()] = String(row.value)
        }
        await writeVaultSecret(vaultPath, vaultData)
      } catch (e) {
        return NextResponse.json(
          { error: `Failed to write to Vault: ${e instanceof Error ? e.message : String(e)}` },
          { status: 502 },
        )
      }

      // Derive updated key mappings from the new secretValues
      const newDataKeys = secretValues.map(r => ({
        remoteKey: r.vaultKey.trim(),
        secretKey: r.k8sKey?.trim() || r.vaultKey.trim(),
      }))

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
          // Always update dataKeys and mark as applied when values are written
          dataKeys:  newDataKeys,
          status:    'applied',
          appliedAt: new Date(),
          statusMessage: null,
        },
        include: { creator: { select: { id: true, username: true, name: true } } },
      })
      return NextResponse.json(secret)
    }

    // No secretValues — metadata-only update
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
        ...(body.dataKeys         !== undefined && { dataKeys:         (body.dataKeys ?? []) as object }),
        ...(body.tags             !== undefined && { tags:             (body.tags ?? []) as object }),
        ...(body.status           !== undefined && { status:           String(body.status) }),
        ...(body.statusMessage    !== undefined && { statusMessage:    body.statusMessage ? String(body.statusMessage) : null }),
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
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { secretId } = await params

  try {
    await prisma.managedSecret.delete({ where: { id: secretId } })
    return new NextResponse(null, { status: 204 })
  } catch {
    return NextResponse.json({ error: 'Failed to delete secret' }, { status: 500 })
  }
}
