import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/nova-definitions
 * List all Nova definitions, optionally filtered by category.
 * Query params:
 *   - category: "skill" | "hook"
 */
export async function GET(req: NextRequest) {
  // MAJOR fix: GET had no auth — any logged-in user could enumerate nova definitions
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
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
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  // MAJOR fix: raw body was passed directly to Prisma (mass assignment).
  // Whitelist allowed fields to prevent setting arbitrary columns.
  const name        = String(body.name ?? '').trim()
  const category    = body.category === 'skill' || body.category === 'hook' ? body.category : 'skill'
  const spec        = typeof body.spec === 'string' ? body.spec : JSON.stringify(body.spec ?? {})
  const title       = body.title ? String(body.title).slice(0, 200) : name
  const description = body.description ? String(body.description).slice(0, 2000) : ''
  const version     = body.version ? String(body.version).slice(0, 50) : '1.0'
  const metadata    = body.metadata ? (typeof body.metadata === 'string' ? body.metadata : JSON.stringify(body.metadata)) : undefined

  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })

  const nova = await prisma.novaDefinition.upsert({
    where: { name },
    update: { category, spec, title, description, version, metadata },
    create: { name, category, spec, title, description, version, metadata },
  })
  return NextResponse.json(nova)
}
