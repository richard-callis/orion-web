import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { prisma } from '@/lib/db'

type Params = { params: Promise<{ id: string; secretId: string }> }

/**
 * PATCH /api/environments/:id/secrets/:secretId
 * Update a managed secret (description, tags, refresh interval, key mappings, etc.)
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { secretId } = await params
  const body = await req.json().catch(() => ({})) as Record<string, unknown>

  try {
    const secret = await prisma.managedSecret.update({
      where: { id: secretId },
      data: {
        ...(body.description     !== undefined && { description:     body.description ? String(body.description) : null }),
        ...(body.namespace       !== undefined && { namespace:       String(body.namespace) }),
        ...(body.secretStore     !== undefined && { secretStore:     String(body.secretStore) }),
        ...(body.secretStoreKind !== undefined && { secretStoreKind: String(body.secretStoreKind) }),
        ...(body.remoteRef       !== undefined && { remoteRef:       String(body.remoteRef) }),
        ...(body.targetSecretName !== undefined && { targetSecretName: body.targetSecretName ? String(body.targetSecretName) : null }),
        ...(body.refreshInterval !== undefined && { refreshInterval: String(body.refreshInterval) }),
        ...(body.dataKeys !== undefined && { dataKeys: (body.dataKeys ?? []) as object }),
        ...(body.tags    !== undefined && { tags: (body.tags ?? []) as object }),
        ...(body.status          !== undefined && { status: String(body.status) }),
        ...(body.statusMessage   !== undefined && { statusMessage: body.statusMessage ? String(body.statusMessage) : null }),
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
