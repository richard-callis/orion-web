import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * GET /api/environments/[id]/nebula
 * List installed nebula entries for an environment.
 */
export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const entries = await prisma.nebulaInstance.findMany({
    where: { environmentId: params.id },
    include: { novaDefinition: { select: { title: true, version: true } } },
    orderBy: { name: 'asc' },
  })
  return NextResponse.json(entries)
}

/**
 * POST /api/environments/[id]/nebula
 * Create a custom nebula entry (operator+ or admin).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const isAdmin = req.headers.get('x-admin') === 'true'
  if (!isAdmin) {
    return NextResponse.json(
      { error: 'Operator access required' },
      { status: 403 }
    )
  }
  const body = await req.json()
  const entry = await prisma.nebulaInstance.create({
    data: { ...body, environmentId: params.id, isForked: true },
  })
  return NextResponse.json(entry)
}
