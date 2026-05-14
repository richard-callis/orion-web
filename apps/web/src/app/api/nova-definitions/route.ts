import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * GET /api/nova-definitions
 * List all Nova definitions, optionally filtered by category.
 * Query params:
 *   - category: "skill" | "hook"
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const category = searchParams.get('category')
  const where: Record<string, unknown> = {}
  if (category) where.category = category
  const definitions = await prisma.novaDefinition.findMany({
    where,
    orderBy: { name: 'asc' },
  })
  return NextResponse.json(definitions)
}

/**
 * POST /api/nova-definitions
 * Create or update a Nova definition (admin only).
 */
export async function POST(req: NextRequest) {
  const isAdmin = req.headers.get('x-admin') === 'true'
  if (!isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }
  const body = await req.json()
  const nova = await prisma.novaDefinition.upsert({
    where: { name: (body as any).name },
    update: body as any,
    create: body as any,
  })
  return NextResponse.json(nova)
}
