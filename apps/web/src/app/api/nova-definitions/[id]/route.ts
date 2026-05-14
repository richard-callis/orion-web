import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/nova-definitions/[id]
 * Get definition details by ID.
 */
export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const nova = await prisma.novaDefinition.findUnique({
    where: { id: params.id },
  })
  if (!nova) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return NextResponse.json(nova)
}

/**
 * PUT /api/nova-definitions/[id]
 * Update a Nova definition (admin only).
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }
  const body = await req.json()
  const nova = await prisma.novaDefinition.update({
    where: { id: params.id },
    data: body,
  })
  return NextResponse.json(nova)
}

/**
 * DELETE /api/nova-definitions/[id]
 * Delete a Nova definition (admin only). Fails with 409 if it has instances.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }
  // Check for instances
  const instances = await prisma.nebulaInstance.findFirst({
    where: { sourceNovaId: params.id },
  })
  if (instances) {
    return NextResponse.json(
      { error: 'Cannot delete — has instances' },
      { status: 409 }
    )
  }
  await prisma.novaDefinition.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
