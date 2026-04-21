import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

/**
 * GET /api/novas/[id] — Get a specific Nova
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const nova = await prisma.nova.findUnique({
    where: { id: params.id },
    include: {
      revisions: { orderBy: { createdAt: 'desc' }, take: 10 },
      deployments: { orderBy: { deployedAt: 'desc' }, take: 20 },
    },
  })

  if (!nova) {
    return NextResponse.json({ error: 'Nova not found' }, { status: 404 })
  }

  return NextResponse.json({
    ...nova,
    config: nova.config as any,
    tags: nova.tags as string[],
  })
}

/**
 * PUT /api/novas/[id] — Update a Nova definition
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const body = await req.json()
  const nova = await prisma.nova.findUnique({
    where: { id: params.id },
  })

  if (!nova) {
    return NextResponse.json({ error: 'Nova not found' }, { status: 404 })
  }

  // Prepare update data
  const data: Record<string, unknown> = {}
  if (body.name !== undefined) data.name = body.name.trim()
  if (body.displayName !== undefined) data.displayName = body.displayName.trim()
  if (body.description !== undefined) data.description = body.description
  if (body.category !== undefined) data.category = body.category
  if (body.version !== undefined) data.version = body.version
  if (body.config !== undefined) data.config = body.config
  if (body.tags !== undefined) data.tags = body.tags

  // Save revision before updating
  const prevConfig = nova.config ? { ...(nova.config as Record<string, unknown>) } : {}
  const newConfig = data.config || prevConfig

  const updatedNova = await prisma.nova.update({
    where: { id: params.id },
    data,
  })

  // Create revision
  await prisma.novaRevision.create({
    data: {
      novaId: nova.id,
      version: nova.version,
      diff: JSON.stringify({ type: 'update', prev: prevConfig, next: newConfig }),
      createdBy: 'admin',
      reasoning: body.reasoning || 'Updated Nova definition',
    },
  })

  return NextResponse.json(updatedNova)
}

/**
 * DELETE /api/novas/[id] — Delete a Nova
 * Only allowed if the Nova has no deployments.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const nova = await prisma.nova.findUnique({
    where: { id: params.id },
    include: { _count: { select: { deployments: true } } },
  })

  if (!nova) {
    return NextResponse.json({ error: 'Nova not found' }, { status: 404 })
  }

  if (nova._count.deployments > 0) {
    return NextResponse.json(
      { error: 'Cannot delete Nova with existing deployments' },
      { status: 409 }
    )
  }

  await prisma.nova.delete({
    where: { id: params.id },
  })

  return new NextResponse(null, { status: 204 })
}
