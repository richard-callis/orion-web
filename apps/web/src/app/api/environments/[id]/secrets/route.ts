import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { prisma } from '@/lib/db'

type Params = { params: Promise<{ id: string }> }

/**
 * GET /api/environments/:id/secrets
 * Returns all managed secrets for this environment.
 */
export async function GET(_: NextRequest, { params }: Params) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

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
 * Create a new managed secret definition.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id: environmentId } = await params
  const body = await req.json().catch(() => ({})) as Record<string, unknown>

  const name = String(body.name ?? '').trim()
  const remoteRef = String(body.remoteRef ?? '').trim()

  if (!name)      return NextResponse.json({ error: 'name is required' }, { status: 400 })
  if (!remoteRef) return NextResponse.json({ error: 'remoteRef is required' }, { status: 400 })

  try {
    const secret = await prisma.managedSecret.create({
      data: {
        environmentId,
        createdBy: user.id,
        name,
        namespace:       String(body.namespace       ?? 'default').trim() || 'default',
        description:     body.description ? String(body.description).trim() : null,
        secretStore:     String(body.secretStore     ?? 'vault-backend').trim() || 'vault-backend',
        secretStoreKind: String(body.secretStoreKind ?? 'ClusterSecretStore').trim() || 'ClusterSecretStore',
        remoteRef,
        targetSecretName: body.targetSecretName ? String(body.targetSecretName).trim() || null : null,
        refreshInterval:  String(body.refreshInterval ?? '1h').trim() || '1h',
        dataKeys: Array.isArray(body.dataKeys) ? body.dataKeys : [],
        tags:     Array.isArray(body.tags)     ? body.tags     : [],
        status:  'draft',
      },
      include: { creator: { select: { id: true, username: true, name: true } } },
    })
    return NextResponse.json(secret, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Failed to create secret' }, { status: 500 })
  }
}
